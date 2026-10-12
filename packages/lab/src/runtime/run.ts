import type { Actor, MockBot, WorldSnapshot } from '@slipher/testing';
import type {
	ActorSpec,
	InspectedPending,
	InspectedRestCall,
	InspectorSnapshot,
	Preset,
	ScenarioContext,
	SessionDescription,
	VisibleConversation,
} from '../index';
import { errorText } from '../shared';
import { toJson } from './json';

export interface RunActor {
	key: string;
	handle: Actor;
	spec: ActorSpec;
}

/** State owned by one started session. Dispose and reset drop it whole. */
export interface ActiveRun<R> {
	bot: MockBot;
	refs: Record<string, string>;
	actors: Map<string, RunActor>;
	context: ScenarioContext<R>;
	/** Interaction IDs of pending modals an actor closed locally; the bot is still waiting for them. */
	closedModals: Set<string>;
	/** Message IDs each actor dismissed from their own view. */
	dismissed: Map<string, Set<string>>;
}

type RefScope = Pick<ActiveRun<unknown>, 'bot' | 'refs'>;

export function unknownRefError(refs: Record<string, string>, name: string): Error {
	const available = Object.entries(refs).map(([key, id]) => `${key}=${id}`);
	return new Error(`Unknown ref "${name}"; available refs: ${available.join(', ') || '(none)'}`);
}

/** Resolves a ref name, or a raw ID, to an entity that exists in the current world. */
export function resolveRef(run: RefScope, name: string): string {
	const id = run.refs[name] ?? name;
	const world = run.bot.world.snapshot();
	if (
		world.guilds.some(item => item.id === id) ||
		world.channels.some(item => item.id === id) ||
		world.roles.some(item => item.id === id) ||
		world.members.some(item => item.userId === id) ||
		world.messages.some(item => item.id === id)
	)
		return id;
	throw unknownRefError(run.refs, name);
}

export function requireActor<R>(run: ActiveRun<R>, key: string): RunActor {
	const actor = run.actors.get(key);
	if (!actor) throw new Error(`Unknown actor "${key}"`);
	return actor;
}

export const actorUserId = (run: RefScope, actor: RunActor): string => resolveRef(run, actor.spec.userId);

/** What an actor sees in a channel, minus the messages they dismissed. */
export function conversation<R>(run: ActiveRun<R>, actor: RunActor, channelId: string): VisibleConversation {
	const view = run.bot.conversation({ userId: actorUserId(run, actor), channelId });
	const dismissed = run.dismissed.get(actor.key);
	return { ...view, messages: view.messages.filter(message => !dismissed?.has(message.id)) };
}

/** Reads pending interactions and forgets local closes of modals the bot no longer waits for. */
export function pendingInteractions<R>(run: ActiveRun<R>): ReturnType<MockBot['pendingInteractions']> {
	const pending = run.bot.pendingInteractions();
	const live = new Set(pending.modals.map(modal => modal.interactionId));
	for (const id of run.closedModals) if (!live.has(id)) run.closedModals.delete(id);
	return pending;
}

export function inspectRun<R>(run: ActiveRun<R>, diagnostics: readonly string[]): InspectorSnapshot {
	const pending = pendingInteractions(run);
	return {
		world: toJson(run.bot.world.snapshot()),
		rest: toJson<InspectedRestCall[]>(
			run.bot.restCalls().map(call => ({ ...call, ...(call.error ? { error: errorText(call.error) } : {}) })),
		),
		pending: toJson<InspectedPending>({
			...pending,
			modals: pending.modals.map(modal => ({ ...modal, closed: run.closedModals.has(modal.interactionId) })),
		}),
		diagnostics: [...diagnostics],
		local: { dismissed: Object.fromEntries([...run.dismissed].map(([actor, ids]) => [actor, [...ids]])) },
	};
}

/** Display name per member, preferring the guild nickname, then the user's names, then the ref name. */
async function memberNames<R>(run: ActiveRun<R>, world: WorldSnapshot): Promise<Record<string, string>> {
	const names: Record<string, string> = {};
	for (const member of world.members) {
		const user = await run.bot.client.cache.users?.raw(member.userId);
		names[member.userId] =
			member.nick ||
			user?.global_name ||
			user?.username ||
			Object.entries(run.refs).find(([, id]) => id === member.userId)?.[0] ||
			member.userId;
	}
	return names;
}

export async function actorName<R>(run: ActiveRun<R>, actor: RunActor): Promise<string> {
	return (await memberNames(run, run.bot.world.snapshot()))[actorUserId(run, actor)] ?? actor.key;
}

export async function describeRun<R>(run: ActiveRun<R>, preset: Preset): Promise<SessionDescription> {
	const { bot } = run;
	const world = bot.world.snapshot();
	const users = await memberNames(run, world);
	const rolesByGuild = (userId: string) =>
		Object.fromEntries(
			world.guilds.map(guild => [
				guild.id,
				world.members.find(member => member.guildId === guild.id && member.userId === userId)?.roles ?? [],
			]),
		);
	const actors: SessionDescription['actors'] = [...run.actors.values()].map(actor => {
		const userId = actorUserId(run, actor);
		users[userId] ??= actor.key;
		return {
			key: actor.key,
			userId,
			name: users[userId],
			guildId: actor.spec.guildId ? resolveRef(run, actor.spec.guildId) : undefined,
			channelId: resolveRef(run, actor.spec.channelId),
			roles: rolesByGuild(userId),
		};
	});
	const botId = bot.client.botId;
	const botUser = await bot.client.cache.users?.raw(botId);
	users[botId] = botUser?.global_name || botUser?.username || users[botId] || 'Bot';
	const guilds = world.guilds.map(guild => ({
		id: guild.id,
		name: guild.name,
		roles: world.roles
			.filter(role => role.guildId === guild.id)
			.map(({ id, name, position, permissions }) => ({ id, name, position, permissions })),
		members: world.members
			.filter(member => member.guildId === guild.id)
			.map(member => ({
				id: member.userId,
				name: users[member.userId] ?? member.userId,
				bot: member.userId === botId,
			})),
		channels: world.channels
			.filter(channel => channel.guildId === guild.id)
			.map(channel => ({
				id: channel.id,
				name: channel.name,
				type: channel.type,
				visibleTo: actors
					.filter(
						actor =>
							!bot
								.conversation({ userId: actor.userId, channelId: channel.id })
								.diagnostics.includes('no-view-channel'),
					)
					.map(actor => actor.key),
			})),
	}));
	if (!actors.some(actor => actor.userId === botId))
		actors.push({ key: 'bot', userId: botId, name: users[botId], channelId: '', roles: rolesByGuild(botId) });
	return {
		preset: { ...preset },
		refs: { ...run.refs },
		actors,
		guilds,
		names: {
			users,
			roles: Object.fromEntries(world.roles.map(role => [role.id, role.name])),
			channels: Object.fromEntries(world.channels.map(channel => [channel.id, channel.name])),
		},
	};
}
