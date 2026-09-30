import type {
	ApiChannel,
	ChatInputInteractionOptions,
	DispatchResult,
	PendingModal,
	VisibleMessage,
} from '@slipher/testing';
import type { LabAction, Locator } from '../index';
import { errorText } from '../shared';
import { hasCustomId, messageShows, visibleMessageText } from './messages';
import {
	actorName,
	actorUserId,
	conversation,
	pendingInteractions,
	type Run,
	type RunActor,
	requireActor,
	resolveRef,
} from './run';

type UserAction = Extract<LabAction, { kind: 'user' }>;
type AdminAction = Extract<LabAction, { kind: 'admin' }>;
type LocalAction = Extract<LabAction, { kind: 'local' }>;

export interface ActionResult {
	summary?: string;
	dispatch?: DispatchResult;
	/** The action as it should be logged, when that differs from the requested action. */
	recorded?: LabAction;
}

export async function performAction<R>(run: Run<R>, action: LabAction): Promise<ActionResult> {
	switch (action.kind) {
		case 'user':
			return performUserAction(run, action);
		case 'admin':
			return performAdminAction(run, action);
		case 'local':
			return performLocalAction(run, action);
	}
}

async function performAdminAction<R>(run: Run<R>, action: AdminAction): Promise<ActionResult> {
	const input = {
		guildId: resolveRef(run, action.guild),
		userId: resolveRef(run, action.member),
		roleId: resolveRef(run, action.role),
	};
	if (action.op === 'addRole') await run.bot.admin.addMemberRole(input);
	else await run.bot.admin.removeMemberRole(input);
	return {};
}

function performLocalAction<R>(run: Run<R>, action: LocalAction): ActionResult {
	const actor = requireActor(run, action.actor);
	if (action.op === 'dismissMessage') {
		const message = dismissTarget(run, actor, action.source);
		const ids = run.dismissed.get(actor.key) ?? new Set<string>();
		ids.add(message.id);
		run.dismissed.set(actor.key, ids);
		// Replay cannot rely on message IDs, so the log keeps visible text that identifies the message.
		const { contains } = action.source;
		const replayText = contains && messageShows(message, contains) ? contains : visibleMessageText(message.payload)[0];
		return {
			summary: 'message dismissed',
			recorded: { ...action, source: { ...action.source, contains: replayText } },
		};
	}
	const userId = actorUserId(run, actor);
	const modal = pendingInteractions(run).modals.find(
		item => item.userId === userId && item.customId === action.customId,
	);
	if (!modal) throw new Error(`No pending modal "${action.customId}" for ${action.actor}`);
	if (action.op === 'closeModal') {
		run.closedModals.add(modal.interactionId);
		return { summary: 'modal closed locally' };
	}
	run.closedModals.delete(modal.interactionId);
	return { summary: 'modal reopened' };
}

function dismissTarget<R>(run: Run<R>, actor: RunActor, source: Locator): VisibleMessage {
	const messages = conversation(run, actor, resolveRef(run, source.channel)).messages;
	const ownerId = actorUserId(run, actor);
	const { messageRef, contains, customId } = source;
	let message: VisibleMessage | undefined;
	if (messageRef) {
		// A dismissed or deleted message is gone from the view, so it is not resolved against the world.
		message = messages.find(item => item.id === (run.refs[messageRef] ?? messageRef));
		if (!message) throw new Error('Message is no longer visible');
	} else if (contains)
		message = messages.findLast(
			item =>
				item.visibility === 'ephemeral' &&
				item.ownerId === ownerId &&
				messageShows(item, contains) &&
				(!customId || hasCustomId(item.payload.components, customId)),
		);
	if (!message) throw new Error('No visible message matches the dismiss source');
	if (message.visibility !== 'ephemeral' || message.ownerId !== ownerId)
		throw new Error('Only your ephemeral messages can be dismissed');
	return message;
}

/** A user action ready to run: where it happens, and how to tell whether a pending modal came from it. */
interface UserStep {
	opened(modal: PendingModal): boolean;
	dispatch(): Promise<DispatchResult>;
}

async function performUserAction<R>(run: Run<R>, action: UserAction): Promise<ActionResult> {
	const actor = requireActor(run, action.actor);
	const userId = actorUserId(run, actor);
	const pending = pendingInteractions(run).modals.find(modal => modal.userId === userId);
	const step = prepareUserStep(run, actor, action);
	// Repeating the action that opened a still-pending modal shows that modal again, as Discord would.
	if (pending && step.opened(pending)) {
		run.closedModals.delete(pending.interactionId);
		return { summary: 'modal reopened' };
	}
	try {
		return { dispatch: await step.dispatch() };
	} catch (error) {
		if (pending && errorText(error).includes('already has a pending flow'))
			throw new Error(
				`${await actorName(run, actor)} has an unfinished form “${pending.payload.title}”. Reopen it from its button or submit it first.`,
			);
		throw error;
	}
}

function prepareUserStep<R>(run: Run<R>, actor: RunActor, action: UserAction): UserStep {
	const { handle } = actor;
	switch (action.verb) {
		case 'slash': {
			const channel = actionChannel(run, actor, action.channel ?? actor.spec.channelId);
			return {
				opened: ({ source }) =>
					source?.channelId === channel.id &&
					!source.messageId &&
					source.commandName === action.command &&
					source.group === action.group &&
					source.subcommand === action.subcommand &&
					normalizedOptions(source.options) === normalizedOptions(action.options),
				dispatch: () =>
					handle.slash({
						name: action.command,
						channel,
						group: action.group,
						subcommand: action.subcommand,
						// validateLabAction checked the bag shape; the mock bot checks each option against the command.
						options: action.options as ChatInputInteractionOptions['options'],
					}),
			};
		}
		case 'click':
		case 'select': {
			const channel = actionChannel(run, actor, action.source.channel);
			const messageId = locate(run, actor, action.source);
			const fromThisComponent = (source: PendingModal['source']) =>
				source?.channelId === channel.id && source.customId === action.customId && source.messageId === messageId;
			if (action.verb === 'click')
				return {
					opened: ({ source }) => fromThisComponent(source),
					dispatch: () => handle.clickButton(action.customId, { channel, source: messageId }),
				};
			return {
				opened: ({ source }) =>
					fromThisComponent(source) &&
					source?.values !== undefined &&
					JSON.stringify(source.values) === JSON.stringify(action.values),
				dispatch: () => handle.selectMenu(action.customId, action.values, { channel, source: messageId }),
			};
		}
		case 'submitModal': {
			const channel = actionChannel(run, actor, action.channel ?? actor.spec.channelId);
			return {
				opened: () => false,
				dispatch: () => handle.submitModal(action.customId, action.fields, { channel }),
			};
		}
	}
}

/** The channel payload for an action, after checking the actor may act there. */
function actionChannel<R>(run: Run<R>, actor: RunActor, channelRef: string): ApiChannel {
	const channelId = resolveRef(run, channelRef);
	const channel = run.bot.world.query.channel({ id: channelId });
	if (!channel) throw new Error(`Unknown channel "${channelRef}"`);
	if (actor.spec.guildId && channel.guildId !== resolveRef(run, actor.spec.guildId))
		throw new Error(`Actor "${actor.key}" does not belong to channel "${channelRef}" guild`);
	const view = run.bot.conversation({ userId: actorUserId(run, actor), channelId });
	if (view.diagnostics.includes('no-view-channel'))
		throw new Error(`Actor "${actor.key}" cannot view channel "${channelRef}" (ViewChannel)`);
	return {
		id: channel.id,
		type: channel.type,
		name: channel.name ?? '',
		...(channel.guildId ? { guild_id: channel.guildId } : {}),
		...(channel.parentId ? { parent_id: channel.parentId } : {}),
		position: channel.position,
		permission_overwrites: channel.overwrites,
		nsfw: channel.nsfw,
		...(channel.topic !== undefined ? { topic: channel.topic } : {}),
		...(channel.rateLimitPerUser !== undefined ? { rate_limit_per_user: channel.rateLimitPerUser } : {}),
		...(channel.threadMetadata ? { thread_metadata: channel.threadMetadata } : {}),
	};
}

/** The single message a locator matches in what the actor sees. */
function locate<R>(run: Run<R>, actor: RunActor, locator: Locator): string {
	const channelId = resolveRef(run, locator.channel);
	const messages = conversation(run, actor, channelId).messages;
	const { messageRef, contains, author, customId } = locator;
	const candidates = messages.filter(
		message =>
			(!messageRef || message.id === resolveRef(run, messageRef)) &&
			(!contains || messageShows(message, contains)) &&
			(!author || message.payload.author?.id === (author === 'bot' ? run.bot.client.botId : resolveRef(run, author))) &&
			(!customId || hasCustomId(message.payload.components, customId)),
	);
	if (candidates.length !== 1) {
		const listed = messages.map(item => `${item.id}:${item.payload.content ?? ''}`).join(', ') || '(none)';
		throw new Error(`Locator matched ${candidates.length} messages in ${channelId}; candidates: ${listed}`);
	}
	return candidates[0].id;
}

/**
 * Canonical text for slash options, so a recorded opener compares equal to a repeated action whether options
 * are a name→value record, a `{ name, value }` list, or encoded option envelopes.
 */
function normalizedOptions(value: unknown): string {
	if (value === undefined || value === null) return '{}';
	if (Array.isArray(value)) {
		if (value.length === 0) return '{}';
		if (value.every(item => item && typeof item === 'object' && 'name' in item && 'value' in item))
			return normalizedOptions(Object.fromEntries(value.map(item => [item.name, item.value])));
		return JSON.stringify(value.map(normalizedOptions));
	}
	if (typeof value === 'object') {
		if ('__slipherOption' in value && 'value' in value) return normalizedOptions(value.value);
		const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
		return JSON.stringify(Object.fromEntries(entries.map(([key, item]) => [key, normalizedOptions(item)])));
	}
	return JSON.stringify(value);
}
