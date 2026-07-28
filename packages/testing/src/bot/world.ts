import { CacheFrom, type UsingClient } from 'seyfert';
import { TEST_BOT_ID } from './constants';
import {
	type ApiAuditLogEntry,
	type ApiAuditLogEntryOptions,
	type ApiAutoModRule,
	type ApiAutoModRuleOptions,
	type ApiChannel,
	type ApiChannelOptions,
	type ApiEmoji,
	type ApiEmojiOptions,
	type ApiGuild,
	type ApiGuildOptions,
	type ApiGuildTemplate,
	type ApiGuildTemplateOptions,
	type ApiInvite,
	type ApiInviteOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiMessageOptions,
	type ApiRole,
	type ApiRoleOptions,
	type ApiScheduledEvent,
	type ApiScheduledEventOptions,
	type ApiSoundboardSound,
	type ApiSoundboardSoundOptions,
	type ApiStageInstance,
	type ApiStageInstanceOptions,
	type ApiSticker,
	type ApiStickerOptions,
	type ApiThreadOptions,
	type ApiUser,
	type ApiUserOptions,
	type ApiVoiceState,
	type ApiVoiceStateOptions,
	type ApiWebhook,
	type ApiWebhookOptions,
	apiAuditLogEntry,
	apiAutoModRule,
	apiChannel,
	apiEmoji,
	apiGuild,
	apiGuildTemplate,
	apiInvite,
	apiMember,
	apiMessage,
	apiRole,
	apiScheduledEvent,
	apiSoundboardSound,
	apiStageInstance,
	apiSticker,
	apiThread,
	apiUser,
	apiVoiceState,
	apiWebhook,
} from './payloads';
import type { PermissionInput } from './permissions';
import { permissionBits } from './permissions';

/**
 * The built world: plain, cloneable data, which is what `createMockBot({ world })` seeds into the cache.
 *
 * Named for what it is, not `MockWorld` — that name belongs to whatever `mockWorld()` returns by the
 * package's own `mockX(): MockX` rule, and `mockWorld()` returns the builder. Typing a helper parameter
 * `MockWorld` and passing it `mockWorld()` used not to compile, which is the wrong thing to learn from a
 * name. Use {@link WorldBuilder} for the thing with the `register*` methods.
 */
export interface WorldData {
	guilds: ApiGuild[];
	channels: ApiChannel[];
	users: ApiUser[];
	members: { guildId: string; member: ApiMember }[];
	roles: { guildId: string; role: ApiRole }[];
	messages: { channelId: string; message: ApiMessage }[];
	voiceStates?: { guildId: string; voiceState: ApiVoiceState }[];
	guildEmojis?: { guildId: string; emoji: ApiEmoji }[];
	invites?: ApiInvite[];
	autoModRules?: { guildId: string; rule: ApiAutoModRule }[];
	webhooks?: ApiWebhook[];
	guildStickers?: { guildId: string; sticker: ApiSticker }[];
	scheduledEvents?: { guildId: string; event: ApiScheduledEvent }[];
	guildTemplates?: { guildId: string; template: ApiGuildTemplate }[];
	soundboardSounds?: { guildId: string; sound: ApiSoundboardSound }[];
	stageInstances?: ApiStageInstance[];
	auditLogEntries?: { guildId: string; entry: ApiAuditLogEntry }[];
	/**
	 * Families the mock otherwise only ever derives from REST during a run. Seeding one states a precondition
	 * that already held before the test started — "this user was already banned", "this message was already
	 * pinned" — instead of establishing it with a REST call the assertion then has to skip past in `restCalls`.
	 */
	bans?: { guildId: string; userId: string; reason?: string }[];
	pins?: { channelId: string; messageId: string }[];
	reactions?: { channelId: string; messageId: string; emoji: string; userId: string }[];
	threadMembers?: { channelId: string; userId: string }[];
	pollVotes?: { channelId: string; messageId: string; answerId: number; userId: string }[];
	/**
	 * App-specific key/value store, untouched by the mock. A domain layer seeds its own state here (and a test
	 * reads it back via {@link MockBot.worldData}); the mock never interprets or mutates it. Pure passthrough.
	 */
	data?: Record<string, unknown>;
}

type GuildRelatedCacheResource = {
	namespace?: string;
	adapter?: {
		bulkSet?: (entries: [string, unknown][]) => unknown;
	};
	parse?: (data: Record<string, unknown>, id: string, guildId: string) => unknown;
};

function needsNamespaceAlias(
	resource: GuildRelatedCacheResource | undefined,
	id: string,
): resource is GuildRelatedCacheResource {
	const namespace = resource?.namespace;
	return typeof namespace === 'string' && id.startsWith(namespace);
}

async function writeNamespaceAlias(
	resource: GuildRelatedCacheResource | undefined,
	id: string,
	guildId: string,
	data: Record<string, unknown>,
): Promise<void> {
	if (!needsNamespaceAlias(resource, id)) return;
	const aliasKey = `${resource.namespace}.${id}`;
	const parsed = resource.parse?.({ ...data }, id, guildId) ?? { ...data, id, guild_id: guildId };
	await Promise.resolve(resource.adapter?.bulkSet?.([[aliasKey, parsed]]));
}

export async function seedCachedRole(client: UsingClient, guildId: string, role: ApiRole): Promise<void> {
	await client.cache.roles?.set(CacheFrom.Test, role.id, guildId, role);
	await writeNamespaceAlias(client.cache.roles as GuildRelatedCacheResource | undefined, role.id, guildId, {
		...(role as unknown as Record<string, unknown>),
	});
}

export type ChannelOverwriteInput = {
	id: string;
	type: 'role' | 'member';
	allow?: PermissionInput;
	deny?: PermissionInput;
};

export type WorldChannelOptions = Omit<ApiChannelOptions, 'guildId' | 'permissionOverwrites'> & {
	overwrites?: ChannelOverwriteInput[];
};

export type WorldRoleOptions = Omit<ApiRoleOptions, 'permissions'> & {
	permissions?: PermissionInput;
};

export type WorldGuildOptions = ApiGuildOptions & {
	everyonePermissions?: PermissionInput;
};

export type WorldThreadOptions = Omit<ApiThreadOptions, 'parentId' | 'guildId'>;

export type WorldEmojiOptions = Omit<ApiEmojiOptions, 'guildId'>;

export type WorldInviteOptions = Omit<ApiInviteOptions, 'channelId' | 'guildId'>;

export type WorldBotMemberOptions = { roles?: string[]; botId?: string };

/** Username given to the member seeded by {@link WorldBuilder.registerBotMember}. */
const BOT_USERNAME = 'slipher-test-bot';

/**
 * A registered guild: the `ApiGuild` payload plus the guild-scoped registrars, so the guild id is stated
 * once at `registerGuild` instead of at every call. The methods are non-enumerable, so the value still
 * clones, serializes and deep-equals as the plain payload it also is.
 */
export interface WorldGuild extends ApiGuild {
	registerRole(options?: WorldRoleOptions): ApiRole;
	registerChannel(options?: WorldChannelOptions): ApiChannel;
	registerMember(options?: ApiMemberOptions): ApiMember;
	registerBotMember(options?: WorldBotMemberOptions): ApiMember;
	registerVoiceState(options?: ApiVoiceStateOptions): ApiVoiceState;
	registerEmoji(options?: WorldEmojiOptions): ApiEmoji;
	registerSticker(options?: Omit<ApiStickerOptions, 'guildId'>): ApiSticker;
	registerAutoModRule(options?: Omit<ApiAutoModRuleOptions, 'guildId'>): ApiAutoModRule;
	registerScheduledEvent(options?: Omit<ApiScheduledEventOptions, 'guildId'>): ApiScheduledEvent;
	registerGuildTemplate(options?: Omit<ApiGuildTemplateOptions, 'sourceGuildId'>): ApiGuildTemplate;
	registerSoundboardSound(options?: Omit<ApiSoundboardSoundOptions, 'guildId'>): ApiSoundboardSound;
	registerAuditLogEntry(options?: ApiAuditLogEntryOptions): ApiAuditLogEntry;
}

export class WorldBuilder {
	private readonly world: WorldData;

	/**
	 * @internal Passing a world continues seeding one that is already live. `MockBot.seed` uses it so the
	 * registrars stay usable against a running bot instead of being frozen at `createMockBot`.
	 */
	constructor(seed?: WorldData) {
		this.world = seed ?? {
			guilds: [],
			channels: [],
			users: [],
			members: [],
			roles: [],
			messages: [],
			voiceStates: [],
			guildEmojis: [],
			invites: [],
			autoModRules: [],
			webhooks: [],
		};
	}

	/** Members seeded by registerBotMember, kept so adoptBotId can restate their user id. */
	private readonly botMembers: ApiMember[] = [];
	/** Bot id explicitly given to registerBotMember, if any. */
	private pinnedBotId?: string;

	private requireGuild(guildId: string): void {
		if (this.world.guilds.some(guild => guild.id === guildId)) return;
		const seeded = this.world.guilds.map(guild => guild.id).join(', ') || '(none)';
		throw new TypeError(`mockWorld: guild "${guildId}" is not registered. Seeded guilds: ${seeded}.`);
	}

	private requireChannel(channelId: string): ApiChannel {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (channel) return channel;
		const seeded = this.world.channels.map(entry => entry.id).join(', ') || '(none)';
		throw new TypeError(`mockWorld: channel "${channelId}" is not registered. Seeded channels: ${seeded}.`);
	}

	registerGuild(options: WorldGuildOptions = {}): WorldGuild {
		const guild = apiGuild(options);
		this.world.guilds.push(guild);
		this.world.roles.push({
			guildId: guild.id,
			role: apiRole({
				id: guild.id,
				name: '@everyone',
				permissions: permissionBits(options.everyonePermissions ?? '0'),
				position: 0,
			}),
		});
		return this.scopeToGuild(guild);
	}

	/**
	 * Bind the guild-scoped registrars onto the payload itself.
	 *
	 * Non-enumerable is load-bearing, not cosmetic: `createMockBot` runs `structuredClone(world.build())`,
	 * which throws `DataCloneError` on an enumerable function, and a seeded guild has to keep deep-equalling
	 * the plain payload that assertions and `JSON.stringify` expect.
	 */
	private scopeToGuild(guild: ApiGuild): WorldGuild {
		const scope: Omit<WorldGuild, keyof ApiGuild> = {
			registerRole: options => this.registerRole(guild.id, options),
			registerChannel: options => this.registerChannel(guild.id, options),
			registerMember: options => this.registerMember(guild.id, options),
			registerBotMember: options => this.registerBotMember(guild.id, options),
			registerVoiceState: options => this.registerVoiceState(guild.id, options),
			registerEmoji: options => this.registerEmoji(guild.id, options),
			registerSticker: options => this.registerSticker(guild.id, options),
			registerAutoModRule: options => this.registerAutoModRule(guild.id, options),
			registerScheduledEvent: options => this.registerScheduledEvent(guild.id, options),
			registerGuildTemplate: options => this.registerGuildTemplate(guild.id, options),
			registerSoundboardSound: options => this.registerSoundboardSound(guild.id, options),
			registerAuditLogEntry: options => this.registerAuditLogEntry(guild.id, options),
		};
		for (const [name, bound] of Object.entries(scope)) Object.defineProperty(guild, name, { value: bound });
		return guild as WorldGuild;
	}

	registerRole(guildId: string, options: WorldRoleOptions = {}): ApiRole {
		this.requireGuild(guildId);
		const role = apiRole({
			...options,
			permissions: permissionBits(options.permissions ?? '0'),
		});
		this.world.roles.push({ guildId, role });
		return role;
	}

	registerChannel(guildId: string, options: WorldChannelOptions = {}): ApiChannel {
		this.requireGuild(guildId);
		const permissionOverwrites = (options.overwrites ?? []).map(overwrite => ({
			id: overwrite.id,
			type: overwrite.type === 'role' ? 0 : 1,
			allow: permissionBits(overwrite.allow ?? '0'),
			deny: permissionBits(overwrite.deny ?? '0'),
		}));
		const channel = apiChannel({ ...options, guildId, permissionOverwrites });
		this.world.channels.push(channel);
		return channel;
	}

	/**
	 * Register a thread under an existing channel. A thread is a channel of a thread type (default 11
	 * PublicThread) carrying the parent's `parent_id`, the parent's guild, and a `thread_metadata` block, so
	 * it coexists with normal channels yet stays distinguishable by those fields.
	 */
	registerThread(parentChannelId: string, options: WorldThreadOptions = {}): ApiChannel {
		const parent = this.requireChannel(parentChannelId);
		const thread = apiThread({
			...options,
			parentId: parentChannelId,
			guildId: parent.guild_id ?? null,
		});
		this.world.channels.push(thread);
		return thread;
	}

	registerEmoji(guildId: string, options: WorldEmojiOptions = {}): ApiEmoji {
		this.requireGuild(guildId);
		const emoji = apiEmoji({ ...options, guildId });
		(this.world.guildEmojis ??= []).push({ guildId, emoji });
		return emoji;
	}

	registerInvite(channelId: string, options: WorldInviteOptions = {}): ApiInvite {
		const channel = this.requireChannel(channelId);
		const invite = apiInvite({ ...options, channelId, guildId: channel.guild_id });
		(this.world.invites ??= []).push(invite);
		return invite;
	}

	registerAutoModRule(guildId: string, options: Omit<ApiAutoModRuleOptions, 'guildId'> = {}): ApiAutoModRule {
		this.requireGuild(guildId);
		const rule = apiAutoModRule({ ...options, guildId });
		(this.world.autoModRules ??= []).push({ guildId, rule });
		return rule;
	}

	registerWebhook(channelId: string, options: Omit<ApiWebhookOptions, 'channelId' | 'guildId'> = {}): ApiWebhook {
		const channel = this.requireChannel(channelId);
		const webhook = apiWebhook({
			applicationId: TEST_BOT_ID,
			...options,
			channelId,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
		});
		(this.world.webhooks ??= []).push(webhook);
		return webhook;
	}

	registerSticker(guildId: string, options: Omit<ApiStickerOptions, 'guildId'> = {}): ApiSticker {
		this.requireGuild(guildId);
		const sticker = apiSticker({ ...options, guildId });
		(this.world.guildStickers ??= []).push({ guildId, sticker });
		return sticker;
	}

	registerScheduledEvent(guildId: string, options: Omit<ApiScheduledEventOptions, 'guildId'> = {}): ApiScheduledEvent {
		this.requireGuild(guildId);
		const event = apiScheduledEvent({ ...options, guildId });
		(this.world.scheduledEvents ??= []).push({ guildId, event });
		return event;
	}

	registerGuildTemplate(
		guildId: string,
		options: Omit<ApiGuildTemplateOptions, 'sourceGuildId'> = {},
	): ApiGuildTemplate {
		this.requireGuild(guildId);
		const template = apiGuildTemplate({ ...options, sourceGuildId: guildId });
		(this.world.guildTemplates ??= []).push({ guildId, template });
		return template;
	}

	registerSoundboardSound(
		guildId: string,
		options: Omit<ApiSoundboardSoundOptions, 'guildId'> = {},
	): ApiSoundboardSound {
		this.requireGuild(guildId);
		const sound = apiSoundboardSound({ ...options, guildId });
		(this.world.soundboardSounds ??= []).push({ guildId, sound });
		return sound;
	}

	registerStageInstance(channelId: string, options: Omit<ApiStageInstanceOptions, 'channelId'> = {}): ApiStageInstance {
		const channel = this.requireChannel(channelId);
		const stage = apiStageInstance({ ...options, channelId, guildId: channel.guild_id });
		(this.world.stageInstances ??= []).push(stage);
		return stage;
	}

	registerAuditLogEntry(guildId: string, options: ApiAuditLogEntryOptions = {}): ApiAuditLogEntry {
		this.requireGuild(guildId);
		const entry = apiAuditLogEntry(options);
		(this.world.auditLogEntries ??= []).push({ guildId, entry });
		return entry;
	}

	/** State that a user is already banned, without dispatching the ban that would put it in `restCalls`. */
	registerBan(guildId: string, options: { userId: string; reason?: string }): void {
		this.requireGuild(guildId);
		const bans = (this.world.bans ??= []);
		if (bans.some(entry => entry.guildId === guildId && entry.userId === options.userId)) return;
		bans.push({ guildId, userId: options.userId, ...(options.reason === undefined ? {} : { reason: options.reason }) });
	}

	/** State that a message is already pinned. The message must be registered first — a pin needs something to point at. */
	registerPin(channelId: string, messageId: string): void {
		this.requireMessage(channelId, messageId, 'registerPin');
		const pins = (this.world.pins ??= []);
		if (pins.some(entry => entry.channelId === channelId && entry.messageId === messageId)) return;
		pins.push({ channelId, messageId });
	}

	/** State that a user already reacted. `emoji` takes the same forms the dispatch verbs accept (`'👍'`, `'name:id'`). */
	registerReaction(channelId: string, messageId: string, options: { emoji: string; userId: string }): void {
		this.requireMessage(channelId, messageId, 'registerReaction');
		const reactions = (this.world.reactions ??= []);
		if (
			reactions.some(
				entry =>
					entry.channelId === channelId &&
					entry.messageId === messageId &&
					entry.emoji === options.emoji &&
					entry.userId === options.userId,
			)
		) {
			return;
		}
		reactions.push({ channelId, messageId, emoji: options.emoji, userId: options.userId });
	}

	/** State that a user is already in a thread. */
	registerThreadMember(channelId: string, userId: string): void {
		this.requireChannel(channelId);
		const members = (this.world.threadMembers ??= []);
		if (members.some(entry => entry.channelId === channelId && entry.userId === userId)) return;
		members.push({ channelId, userId });
	}

	/** State that a user already voted on a poll answer. */
	registerPollVote(channelId: string, messageId: string, options: { answerId: number; userId: string }): void {
		this.requireMessage(channelId, messageId, 'registerPollVote');
		const votes = (this.world.pollVotes ??= []);
		if (
			votes.some(
				entry =>
					entry.channelId === channelId &&
					entry.messageId === messageId &&
					entry.answerId === options.answerId &&
					entry.userId === options.userId,
			)
		) {
			return;
		}
		votes.push({ channelId, messageId, answerId: options.answerId, userId: options.userId });
	}

	private requireMessage(channelId: string, messageId: string, api: string): void {
		this.requireChannel(channelId);
		const exists = this.world.messages.some(entry => entry.channelId === channelId && entry.message.id === messageId);
		if (!exists) {
			throw new TypeError(
				`${api}: no message "${messageId}" in channel "${channelId}". Register the message first — ` +
					'world.registerMessage(channelId, { id }) returns it.',
			);
		}
	}

	registerUser(options: ApiUserOptions = {}): ApiUser {
		const user = apiUser(options);
		this.world.users.push(user);
		return user;
	}

	registerMember(guildId: string, options: ApiMemberOptions = {}): ApiMember {
		this.requireGuild(guildId);
		const member = apiMember(options);
		this.world.members.push({ guildId, member });
		if (!this.world.users.some(user => user.id === member.user.id)) {
			this.world.users.push(member.user);
		}
		return member;
	}

	registerVoiceState(guildId: string, options: ApiVoiceStateOptions = {}): ApiVoiceState {
		this.requireGuild(guildId);
		const voiceState = apiVoiceState(options);
		(this.world.voiceStates ??= []).push({ guildId, voiceState });
		return voiceState;
	}

	registerBotMember(guildId: string, options: WorldBotMemberOptions = {}): ApiMember {
		if (options.botId !== undefined && this.pinnedBotId !== undefined && options.botId !== this.pinnedBotId) {
			throw new TypeError(
				`mockWorld: registerBotMember is already pinned to botId "${this.pinnedBotId}" but got "${options.botId}". ` +
					'A world has one bot; seed the other guild without botId.',
			);
		}
		if (options.botId !== undefined) this.pinnedBotId = options.botId;
		const member = this.registerMember(guildId, {
			user: apiUser({ id: this.pinnedBotId ?? TEST_BOT_ID, bot: true, username: BOT_USERNAME }),
			roles: options.roles,
		});
		this.botMembers.push(member);
		return member;
	}

	/**
	 * @internal Reconcile the seeded bot member with the client's bot id. Called by `createMockBot`.
	 *
	 * The world is seeded before the client is built, so without this the bot's user id is stated twice —
	 * here and as `createMockBot({ botId })` — with nothing keeping the two equal, and a message authored by
	 * the bot member fails `author.id === client.botId`. Runs against the live world *before* `createMockBot`
	 * clones it, so the `ApiMember` that `registerBotMember` already handed back is corrected in place too.
	 *
	 * Returns the stated bot id, or `undefined` when neither side stated one (leaving the default in place).
	 */
	adoptBotId(explicit?: string): string | undefined {
		if (explicit !== undefined && this.pinnedBotId !== undefined && explicit !== this.pinnedBotId) {
			throw new TypeError(
				`createMockBot: botId "${explicit}" conflicts with registerBotMember({ botId: "${this.pinnedBotId}" }). ` +
					'State the bot id once: keep it on createMockBot and drop it from registerBotMember, or the reverse.',
			);
		}
		const stated = explicit ?? this.pinnedBotId;
		if (stated !== undefined) {
			for (const member of this.botMembers) member.user.id = stated;
		}
		return stated;
	}

	/**
	 * Attach an app-specific value under `key` in the world's passthrough data store, read back via
	 * {@link MockBot.worldData}. The mock never interprets it. Returns `this` for chaining.
	 */
	setData(key: string, value: unknown): this {
		(this.world.data ??= {})[key] = value;
		return this;
	}

	registerMessage(channelId: string, options: Omit<ApiMessageOptions, 'channelId'> = {}): ApiMessage {
		const channel = this.requireChannel(channelId);
		const message = apiMessage({
			...options,
			channelId,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
		});
		this.world.messages.push({ channelId, message });
		return message;
	}

	build(): WorldData {
		return this.world;
	}
}

export function mockWorld(): WorldBuilder {
	return new WorldBuilder();
}

/**
 * Clone a world into the shape the client cache gets, translating the one failure that is easy to
 * cause and impossible to read.
 *
 * This is now the backstop, not the primary defence: the `api*` payload types declare themselves plain data
 * (see `PlainPayload`), so `registerMember({ user: richUser(...) })` is a compile error rather than the
 * `DataCloneError` it used to be. The check stays because the types are reachable around — `MockBot.seed`
 * takes a `WorldBuilder` callback, a cast or an `any` bypasses them, and a builder or any other uncloneable
 * value can still reach a world field the types never named. Raw, that failure reads as
 * `DataCloneError: () => Formatter.userMention(id) could not be cloned`, which names neither factory nor the
 * call that seeded it. `api` names the entry point the author actually called.
 */
export function cloneWorld(built: WorldData, api: string): WorldData {
	try {
		return structuredClone(built);
	} catch (error) {
		throw new TypeError(
			`${api}: the seeded world holds a value that cannot be cloned into the client cache — usually a ` +
				'lightweight fixture (richUser, richGuild, richChannel, richMember) or a builder passed where a payload ' +
				'belongs. World seeding takes the payload factories: apiUser, apiGuild, apiChannel, apiMember, apiRole. ' +
				`The rich* fixtures are for mockCommandContext. Original error: ${String(error)}`,
			{ cause: error },
		);
	}
}

/** Writes a WorldData into a Seyfert client's cache using CacheFrom.Test. */
export async function seedWorld(client: UsingClient, world: WorldData): Promise<void> {
	for (const guild of world.guilds) {
		await client.cache.guilds?.set(CacheFrom.Test, guild.id, guild);
	}
	for (const channel of world.channels) {
		if (channel.guild_id) {
			await client.cache.channels?.set(CacheFrom.Test, channel.id, channel.guild_id, channel);
			// seyfert's channel cache strips permission_overwrites into the separate `overwrites` resource, so a
			// seeded channel's overwrites are invisible to cache reads unless seeded there directly.
			if (channel.permission_overwrites?.length) {
				await client.cache.overwrites?.set(CacheFrom.Test, channel.id, channel.guild_id, channel.permission_overwrites);
			}
		}
	}
	for (const entry of world.roles) {
		await seedCachedRole(client, entry.guildId, entry.role);
	}
	for (const user of world.users) {
		await client.cache.users?.set(CacheFrom.Test, user.id, user);
	}
	for (const entry of world.members) {
		await client.cache.members?.set(CacheFrom.Test, entry.member.user.id, entry.guildId, entry.member);
	}
	for (const entry of world.voiceStates ?? []) {
		await client.cache.voiceStates?.set(CacheFrom.Test, entry.voiceState.user_id, entry.guildId, entry.voiceState);
	}
	for (const entry of world.guildEmojis ?? []) {
		await client.cache.emojis?.set(CacheFrom.Test, entry.emoji.id, entry.guildId, entry.emoji);
	}
	for (const entry of world.guildStickers ?? []) {
		await client.cache.stickers?.set(CacheFrom.Test, entry.sticker.id, entry.guildId, entry.sticker);
	}
	for (const stage of world.stageInstances ?? []) {
		if (stage.guild_id) await client.cache.stageInstances?.set(CacheFrom.Test, stage.channel_id, stage.guild_id, stage);
	}
}
