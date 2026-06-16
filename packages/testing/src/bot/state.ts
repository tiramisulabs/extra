import { mockId, mockTimestamp } from '../id';
import { TEST_BOT_ID } from './constants';
import {
	type ApiAttachment,
	type ApiChannel,
	type ApiMessage,
	type ApiPoll,
	type ApiRole,
	type ApiUser,
	type ApiVoiceState,
	apiAttachment,
	apiChannel,
	apiMember,
	apiMessage,
	apiPoll,
	apiRole,
	apiUser,
	apiVoiceState,
	type ThreadMetadata,
} from './payloads';
import type { ChannelOverwriteLike } from './permissions';
import type { MockWorld } from './world';

export interface MessageQuery {
	limit?: number;
	before?: string;
	after?: string;
	around?: string;
}

export interface EmbedView {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	fields: { name: string; value: string; inline?: boolean }[];
	footer?: { text: string };
	author?: { name: string };
	image?: { url: string };
	thumbnail?: { url: string };
}

export interface ButtonView {
	customId?: string;
	label?: string;
	type: number;
	disabled?: boolean;
}

export interface ReactionView {
	emoji: string;
	count: number;
	me: boolean;
	users: string[];
}

export interface AttachmentView {
	id: string;
	filename: string;
	contentType?: string;
	size?: number;
	url?: string;
}

export interface MessageReferenceView {
	messageId?: string;
	channelId?: string;
	type?: number;
}

export interface MessageView {
	id: string;
	channelId: string;
	authorId?: string;
	content?: string;
	embeds: EmbedView[];
	components: unknown[];
	attachments: AttachmentView[];
	buttons: ButtonView[];
	button(labelOrCustomId: string): ButtonView | undefined;
	reactions: ReactionView[];
	reaction(emoji: string): ReactionView | undefined;
	reference?: MessageReferenceView;
	referencedMessage?: { id: string; channelId: string; authorId?: string; content?: string };
	poll?: { question?: string; answers: { answerId: number; text?: string }[]; isFinalized: boolean };
}

export interface ChannelView {
	id: string;
	name?: string;
	type: number;
	parentId?: string;
	topic?: string | null;
	nsfw: boolean;
	rateLimitPerUser?: number;
	position: number;
	archived?: boolean;
	locked?: boolean;
	threadMetadata?: ThreadMetadata;
	overwrites: { id: string; type: number; allow: string; deny: string }[];
	messages: MessageView[];
	lastMessage?: MessageView;
	pins: MessageView[];
}

export interface GuildMemberView {
	userId: string;
	roles: string[];
	nick?: string | null;
	communicationDisabledUntil?: string | null;
}

export interface GuildView {
	id: string;
	name?: string;
	channels: ChannelView[];
	channel(nameOrId: string): ChannelView | undefined;
	threads: ChannelView[];
	thread(nameOrId: string): ChannelView | undefined;
	members: GuildMemberView[];
	member(userId: string): GuildMemberView | undefined;
	role(nameOrId: string): { id: string; name: string; position: number } | undefined;
	bans: string[];
}

/** One member captured in a {@link WorldSnapshot}, identified by `guildId` + `userId`. */
export interface MemberSnapshot {
	guildId: string;
	userId: string;
	roles: string[];
	nick: string | null;
	communicationDisabledUntil: string | null;
}

/** One channel captured in a {@link WorldSnapshot}, identified by `id`. */
export interface ChannelSnapshot {
	id: string;
	guildId?: string;
	name: string;
	type: number;
	parentId?: string;
	overwrites: { id: string; type: number; allow: string; deny: string }[];
}

/** One message captured in a {@link WorldSnapshot}, identified by `id`. */
export interface MessageSnapshot {
	id: string;
	channelId: string;
	authorId: string;
	content: string;
}

/** One role captured in a {@link WorldSnapshot}, identified by `id`. */
export interface RoleSnapshot {
	guildId: string;
	id: string;
	name: string;
	permissions: string;
	position: number;
}

/** One ban captured in a {@link WorldSnapshot}, identified by `guildId` + `userId`. */
export interface BanSnapshot {
	guildId: string;
	userId: string;
}

/**
 * Immutable, plain-data capture of the world at a point in time. Produced by {@link WorldState.snapshot}
 * and consumed by {@link WorldState.diff}. Deeply frozen so later world mutations never alter it.
 */
export interface WorldSnapshot {
	members: MemberSnapshot[];
	channels: ChannelSnapshot[];
	messages: MessageSnapshot[];
	roles: RoleSnapshot[];
	bans: BanSnapshot[];
}

/** A single entity that changed between two snapshots, with the names of the differing fields. */
export interface ChangedEntity<T> {
	before: T;
	after: T;
	fields: string[];
}

/** Added/removed/changed buckets for one entity type in a {@link WorldDiff}. */
export interface EntityDiff<T> {
	added: T[];
	removed: T[];
	changed: ChangedEntity<T>[];
}

/**
 * Structured changeset between a prior {@link WorldSnapshot} and the current world, keyed by entity type.
 * Entities are matched by their stable id (member/ban = guildId+userId, channel/message/role = id);
 * `changed` lists the entities present in both with differing fields.
 */
export interface WorldDiff {
	members: EntityDiff<MemberSnapshot>;
	channels: EntityDiff<ChannelSnapshot>;
	messages: EntityDiff<MessageSnapshot>;
	roles: EntityDiff<RoleSnapshot>;
	bans: EntityDiff<BanSnapshot>;
}

/**
 * The read-only view of {@link WorldState} exposed publicly as `bot.state`. Exposes only the query
 * methods test authors call to assert on world state; the `@internal` mutators that the mock drives
 * in response to Discord traffic are intentionally absent so an internal refactor of them is not a
 * breaking change. The concrete {@link WorldState} class implements this and is used internally.
 */
export interface WorldStateReader {
	snapshot(): WorldSnapshot;
	diff(before: WorldSnapshot): WorldDiff;
	guild(guildId: string): GuildView | undefined;
	dm(userId: string): ChannelView | undefined;
	channelMessages(channelId: string, options?: MessageQuery): Record<string, unknown>[];
	rawMessage(channelId: string, messageId: string): Record<string, unknown> | undefined;
	rawMessageById(messageId: string): Record<string, unknown> | undefined;
	messageForToken(token: string): Record<string, unknown> | undefined;
	webhookMessage(token: string, messageId: string): Record<string, unknown> | undefined;
	channelForToken(token: string): string | undefined;
	reactionUsers(channelId: string, messageId: string, emoji: string): string[];
	bans(guildId: string): string[];
	isBanned(guildId: string, userId: string): boolean;
	pins(channelId: string): Record<string, unknown>[];
	archivedThreads(channelId: string, type: 'public' | 'private'): Record<string, unknown>[];
	pollVoters(channelId: string, messageId: string, answerId: number): string[];
}

const EMPTY_WORLD = (): MockWorld => ({ guilds: [], channels: [], users: [], members: [], roles: [], messages: [] });

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** Field-by-field comparison for the snapshot scalar/array fields; lists the names that differ. */
function changedFields<T extends object>(before: T, after: T): string[] {
	const fields: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const a = (before as Record<string, unknown>)[key];
		const b = (after as Record<string, unknown>)[key];
		if (JSON.stringify(a) !== JSON.stringify(b)) fields.push(key);
	}
	return fields;
}

function diffEntities<T extends object>(before: T[], after: T[], identity: (entity: T) => string): EntityDiff<T> {
	const beforeById = new Map(before.map(entity => [identity(entity), entity]));
	const afterById = new Map(after.map(entity => [identity(entity), entity]));
	const result: EntityDiff<T> = { added: [], removed: [], changed: [] };
	for (const [id, entity] of afterById) {
		const prior = beforeById.get(id);
		if (!prior) {
			result.added.push(entity);
			continue;
		}
		const fields = changedFields(prior, entity);
		if (fields.length) result.changed.push({ before: prior, after: entity, fields });
	}
	for (const [id, entity] of beforeById) {
		if (!afterById.has(id)) result.removed.push(entity);
	}
	return result;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function normalizeOverwrites(value: unknown): ChannelOverwriteLike[] {
	return arrayValue(value).map(overwrite => {
		const raw = asRecord(overwrite);
		return {
			id: stringValue(raw.id) ?? mockId(),
			type: numberValue(raw.type) ?? 0,
			allow: stringValue(raw.allow) ?? '0',
			deny: stringValue(raw.deny) ?? '0',
		};
	});
}

function normalizeThreadMetadata(value: unknown): ThreadMetadata {
	const raw = asRecord(value);
	return {
		archived: typeof raw.archived === 'boolean' ? raw.archived : false,
		auto_archive_duration: numberValue(raw.auto_archive_duration) ?? 1440,
		locked: typeof raw.locked === 'boolean' ? raw.locked : false,
		archive_timestamp: stringValue(raw.archive_timestamp) ?? mockTimestamp(),
	};
}

function normalizePoll(raw: Record<string, unknown>): ApiPoll {
	const question = asRecord(raw.question);
	return apiPoll({
		question: stringValue(question.text) === undefined ? {} : { text: stringValue(question.text) },
		answers: arrayValue(raw.answers).map(entry => {
			const media = asRecord(asRecord(entry).poll_media);
			return stringValue(media.text) === undefined ? {} : { text: stringValue(media.text) };
		}),
		...(typeof raw.allow_multiselect === 'boolean' ? { allowMultiselect: raw.allow_multiselect } : {}),
		...(numberValue(raw.layout_type) === undefined ? {} : { layoutType: numberValue(raw.layout_type) }),
	});
}

function normalizeAttachments(value: unknown): ApiAttachment[] {
	return arrayValue(value).map(entry => {
		const raw = asRecord(entry);
		return apiAttachment({
			...(stringValue(raw.id) === undefined ? {} : { id: stringValue(raw.id) }),
			...(stringValue(raw.filename) === undefined ? {} : { filename: stringValue(raw.filename) }),
			...(stringValue(raw.content_type) === undefined ? {} : { contentType: stringValue(raw.content_type) }),
			...(numberValue(raw.size) === undefined ? {} : { size: numberValue(raw.size) }),
			...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		});
	});
}

function normalizeEmbed(value: unknown): EmbedView {
	const raw = asRecord(value);
	const fields = arrayValue(raw.fields).map(field => {
		const entry = asRecord(field);
		return {
			name: stringValue(entry.name) ?? '',
			value: stringValue(entry.value) ?? '',
			...(typeof entry.inline === 'boolean' ? { inline: entry.inline } : {}),
		};
	});
	return {
		...(stringValue(raw.title) === undefined ? {} : { title: stringValue(raw.title) }),
		...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		...(numberValue(raw.color) === undefined ? {} : { color: numberValue(raw.color) }),
		fields,
		...(asRecord(raw.footer).text === undefined ? {} : { footer: { text: String(asRecord(raw.footer).text) } }),
		...(asRecord(raw.author).name === undefined ? {} : { author: { name: String(asRecord(raw.author).name) } }),
		...(asRecord(raw.image).url === undefined ? {} : { image: { url: String(asRecord(raw.image).url) } }),
		...(asRecord(raw.thumbnail).url === undefined ? {} : { thumbnail: { url: String(asRecord(raw.thumbnail).url) } }),
	};
}

interface DerivedMentions {
	mention_everyone: boolean;
	mentions: ApiUser[];
	mention_roles: string[];
}

function collectButtons(value: unknown, out: ButtonView[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectButtons(entry, out);
		return;
	}
	const raw = asRecord(value);
	const type = numberValue(raw.type);
	if (type !== undefined && type >= 2 && type <= 8) {
		out.push({
			type,
			...(stringValue(raw.custom_id) === undefined ? {} : { customId: stringValue(raw.custom_id) }),
			...(stringValue(raw.label) === undefined ? {} : { label: stringValue(raw.label) }),
			...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
		});
	}
	if (Array.isArray(raw.components)) collectButtons(raw.components, out);
}

export class WorldState implements WorldStateReader {
	private readonly world: MockWorld;
	private readonly bansByGuild = new Map<string, Set<string>>();
	private readonly dmChannelByUser = new Map<string, string>();
	private readonly messageIdByToken = new Map<string, string>();
	private readonly channelIdByToken = new Map<string, string>();
	private readonly reactionsByMessage = new Map<string, Map<string, Set<string>>>();
	private readonly pinnedByChannel = new Map<string, string[]>();
	private readonly pollVotersByMessage = new Map<string, Map<number, Set<string>>>();

	constructor(seed?: MockWorld) {
		this.world = seed ?? EMPTY_WORLD();
		this.world.roles ??= [];
		this.world.messages ??= [];
		for (const channel of this.world.channels) {
			if (channel.type === 1 && channel.id) this.dmChannelByUser.set(channel.id, channel.id);
		}
	}

	/**
	 * Capture the current world entities (members, channels, messages, roles, bans) as an immutable,
	 * plain-data snapshot. Deeply frozen, so later world mutations never alter a captured snapshot. Pair
	 * with {@link diff} to read state mutations declaratively instead of with field-by-field point queries.
	 */
	snapshot(): WorldSnapshot {
		const members: MemberSnapshot[] = this.world.members.map(entry => ({
			guildId: entry.guildId,
			userId: entry.member.user.id,
			roles: [...entry.member.roles],
			nick: entry.member.nick ?? null,
			communicationDisabledUntil: entry.member.communication_disabled_until ?? null,
		}));
		const channels: ChannelSnapshot[] = this.world.channels.map(channel => ({
			id: channel.id,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			name: channel.name,
			type: channel.type,
			...(channel.parent_id === undefined ? {} : { parentId: channel.parent_id }),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
		}));
		const messages: MessageSnapshot[] = this.world.messages.map(entry => ({
			id: entry.message.id,
			channelId: entry.channelId,
			authorId: entry.message.author.id,
			content: entry.message.content,
		}));
		const roles: RoleSnapshot[] = this.world.roles.map(entry => ({
			guildId: entry.guildId,
			id: entry.role.id,
			name: entry.role.name,
			permissions: entry.role.permissions,
			position: entry.role.position,
		}));
		const bans: BanSnapshot[] = [...this.bansByGuild].flatMap(([guildId, userIds]) =>
			[...userIds].map(userId => ({ guildId, userId })),
		);
		return deepFreeze({ members, channels, messages, roles, bans });
	}

	/**
	 * Compare a prior {@link WorldSnapshot} against the CURRENT world and return a structured changeset.
	 * Entities are matched by stable id (member/ban = guildId+userId, channel/message/role = id); `changed`
	 * lists entities present in both whose fields differ, naming those fields.
	 */
	diff(before: WorldSnapshot): WorldDiff {
		const after = this.snapshot();
		return {
			members: diffEntities(before.members, after.members, entity => `${entity.guildId}:${entity.userId}`),
			channels: diffEntities(before.channels, after.channels, entity => entity.id),
			messages: diffEntities(before.messages, after.messages, entity => entity.id),
			roles: diffEntities(before.roles, after.roles, entity => entity.id),
			bans: diffEntities(before.bans, after.bans, entity => `${entity.guildId}:${entity.userId}`),
		};
	}

	guild(guildId: string): GuildView | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		const guildChannels = this.world.channels.filter(channel => channel.guild_id === guild.id);
		const channels = guildChannels
			.filter(channel => !channel.thread_metadata)
			.map(channel => this.channelView(channel));
		const threads = guildChannels.filter(channel => channel.thread_metadata).map(channel => this.channelView(channel));
		const members = this.world.members
			.filter(entry => entry.guildId === guild.id)
			.map(entry => this.memberView(entry.member));
		const roles = this.world.roles.filter(entry => entry.guildId === guild.id).map(entry => entry.role);
		const bans = [...(this.bansByGuild.get(guild.id) ?? new Set<string>())];

		return {
			id: guild.id,
			name: guild.name,
			channels,
			channel: nameOrId =>
				guildChannels
					.filter(channel => !channel.thread_metadata)
					.map(channel => this.channelView(channel))
					.find(channel => channel.id === nameOrId || channel.name === nameOrId),
			threads,
			thread: nameOrId =>
				guildChannels
					.filter(channel => channel.thread_metadata)
					.map(channel => this.channelView(channel))
					.find(channel => channel.id === nameOrId || channel.name === nameOrId),
			members,
			member: userId => {
				const entry = this.world.members.find(
					member => member.guildId === guild.id && member.member.user.id === userId,
				);
				return entry ? this.memberView(entry.member) : undefined;
			},
			role: nameOrId => {
				const role = roles.find(entry => entry.id === nameOrId || entry.name === nameOrId);
				return role ? { id: role.id, name: role.name, position: role.position } : undefined;
			},
			bans,
		};
	}

	dm(userId: string): ChannelView | undefined {
		const channelId = this.dmChannelByUser.get(userId);
		const channel = channelId ? this.world.channels.find(entry => entry.id === channelId) : undefined;
		return channel ? this.channelView(channel) : undefined;
	}

	channelMessages(channelId: string, options?: MessageQuery): Record<string, unknown>[] {
		const chronological = this.world.messages
			.filter(entry => entry.channelId === channelId)
			.map(entry => entry.message);
		const newestFirst = [...chronological].reverse();
		const limit = Math.min(Math.max(options?.limit ?? 50, 0), 100);

		if (options?.after !== undefined) {
			const index = chronological.findIndex(message => message.id === options.after);
			const newer = index === -1 ? newestFirst : newestFirst.filter((_, i) => i < newestFirst.length - index - 1);
			return newer.slice(-limit).map(message => ({ ...message }));
		}

		let slice = newestFirst;
		if (options?.before !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.before);
			slice = index === -1 ? newestFirst : newestFirst.slice(index + 1);
		} else if (options?.around !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.around);
			if (index !== -1) {
				const half = Math.floor(limit / 2);
				slice = newestFirst.slice(Math.max(0, index - half), index - half + limit);
			}
		}
		return slice.slice(0, limit).map(message => ({ ...message }));
	}

	rawMessage(channelId: string, messageId: string): Record<string, unknown> | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	rawMessageById(messageId: string): Record<string, unknown> | undefined {
		const entry = this.world.messages.find(message => message.message.id === messageId);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	/** Discord reflects reactions on the message object as `{ emoji, count, me }`. */
	private withReactions(channelId: string, message: ApiMessage): Record<string, unknown> {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, message.id));
		if (!byEmoji || byEmoji.size === 0) return { ...message };
		const reactions = [...byEmoji].map(([emoji, users]) => ({
			emoji: emoji.includes(':') ? { name: emoji.split(':')[0], id: emoji.split(':')[1] } : { name: emoji, id: null },
			count: users.size,
			me: users.has(TEST_BOT_ID),
		}));
		return { ...message, reactions };
	}

	private rawMessageOr(channelId: string, messageId: string): Record<string, unknown> {
		return this.rawMessage(channelId, messageId) ?? (apiMessage() as unknown as Record<string, unknown>);
	}

	messageForToken(token: string): Record<string, unknown> | undefined {
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		return channelId && messageId ? this.rawMessage(channelId, messageId) : undefined;
	}

	webhookMessage(token: string, messageId: string): Record<string, unknown> | undefined {
		if (messageId === '@original') return this.messageForToken(token);
		const channelId = this.channelIdByToken.get(token);
		return channelId ? this.rawMessage(channelId, messageId) : undefined;
	}

	channelForToken(token: string): string | undefined {
		return this.channelIdByToken.get(token);
	}

	registerInteractionToken(token: string, channelId: string): void {
		this.channelIdByToken.set(token, channelId);
	}

	/** @internal Mock internals normally call this when Discord creates a channel. */
	addChannel(guildId: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
		const type = numberValue(raw.type);
		const parentId = stringValue(raw.parent_id);
		const isThread = type === 11 || type === 12 || raw.thread_metadata !== undefined;
		const channel = apiChannel({
			id: stringValue(raw.id),
			guildId: stringValue(raw.guild_id) ?? guildId ?? null,
			name: stringValue(raw.name),
			type,
			...(parentId === undefined ? {} : { parentId }),
			permissionOverwrites: normalizeOverwrites(raw.permission_overwrites),
			...(isThread ? { threadMetadata: normalizeThreadMetadata(raw.thread_metadata) } : {}),
		});
		this.world.channels.push(channel);
		return { ...channel };
	}

	/** @internal Mock internals normally call this when Discord deletes a channel. */
	removeChannel(channelId: string): void {
		this.world.channels = this.world.channels.filter(channel => channel.id !== channelId);
		for (const message of this.world.messages) {
			if (message.channelId === channelId)
				this.reactionsByMessage.delete(this.reactionKey(channelId, message.message.id));
		}
		this.world.messages = this.world.messages.filter(message => message.channelId !== channelId);
		this.pinnedByChannel.delete(channelId);
		for (const [userId, dmChannelId] of this.dmChannelByUser) {
			if (dmChannelId === channelId) this.dmChannelByUser.delete(userId);
		}
	}

	/**
	 * @internal Mock internals normally call this on VOICE_STATE_UPDATE. Upserts the voice state for
	 * `{guild_id, user_id}`; a null `channel_id` is a disconnect and removes the entry.
	 */
	setVoiceState(raw: Record<string, unknown>): void {
		const guildId = stringValue(raw.guild_id);
		const userId = stringValue(raw.user_id);
		if (!guildId || !userId) return;
		const states = (this.world.voiceStates ??= []);
		const channelId = 'channel_id' in raw ? (stringValue(raw.channel_id) ?? null) : null;
		if (channelId === null) {
			this.world.voiceStates = states.filter(
				entry => !(entry.guildId === guildId && entry.voiceState.user_id === userId),
			);
			return;
		}
		const voiceState: ApiVoiceState = {
			...apiVoiceState({
				userId,
				channelId,
				...(stringValue(raw.session_id) === undefined ? {} : { sessionId: stringValue(raw.session_id) }),
				...(typeof raw.deaf === 'boolean' ? { deaf: raw.deaf } : {}),
				...(typeof raw.mute === 'boolean' ? { mute: raw.mute } : {}),
				...(typeof raw.self_deaf === 'boolean' ? { selfDeaf: raw.self_deaf } : {}),
				...(typeof raw.self_mute === 'boolean' ? { selfMute: raw.self_mute } : {}),
				...(typeof raw.self_video === 'boolean' ? { selfVideo: raw.self_video } : {}),
				...(typeof raw.suppress === 'boolean' ? { suppress: raw.suppress } : {}),
			}),
			guild_id: guildId,
		};
		const existing = states.find(entry => entry.guildId === guildId && entry.voiceState.user_id === userId);
		if (existing) existing.voiceState = voiceState;
		else states.push({ guildId, voiceState });
	}

	/** @internal Mock internals normally call this when Discord opens a DM. */
	registerDm(userId: string, raw: Record<string, unknown>): Record<string, unknown> {
		const channel = this.addChannel(undefined, { ...raw, type: raw.type ?? 1 });
		this.dmChannelByUser.set(userId, String(channel.id));
		return channel;
	}

	private resolveUser(id: string): ApiUser {
		const user = this.world.users.find(entry => entry.id === id);
		if (user) return user;
		const member = this.world.members.find(entry => entry.member.user.id === id);
		return member ? member.member.user : apiUser({ id });
	}

	private deriveMentions(content: string, allowedMentions: unknown): DerivedMentions {
		const allowed = asRecord(allowedMentions);
		const hasAllowed = allowedMentions !== undefined && allowedMentions !== null;
		const parse = Array.isArray(allowed.parse) ? (allowed.parse as unknown[]).map(String) : undefined;
		const userAllowlist = Array.isArray(allowed.users) ? (allowed.users as unknown[]).map(String) : undefined;
		const roleAllowlist = Array.isArray(allowed.roles) ? (allowed.roles as unknown[]).map(String) : undefined;

		const allowCategory = (category: string, allowlist: string[] | undefined): boolean => {
			if (allowlist) return true;
			if (parse) return parse.includes(category);
			return true;
		};

		const result: DerivedMentions = { mention_everyone: false, mentions: [], mention_roles: [] };
		if (!hasAllowed && content === '') return result;

		if (allowCategory('users', userAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (userAllowlist && !userAllowlist.includes(id)) continue;
				result.mentions.push(this.resolveUser(id));
			}
		}

		if (allowCategory('roles', roleAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@&(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (roleAllowlist && !roleAllowlist.includes(id)) continue;
				result.mention_roles.push(id);
			}
		}

		if (allowCategory('everyone', undefined) && /@everyone|@here/.test(content)) {
			result.mention_everyone = true;
		}

		return result;
	}

	/** @internal Mock internals normally call this when Discord creates a message. */
	addMessage(channelId: string, raw: Record<string, unknown>): MessageView {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const rawAuthor = asRecord(raw.author);
		const author: ApiUser =
			'id' in rawAuthor
				? ({
						...apiUser({ id: String(rawAuthor.id) }),
						...rawAuthor,
					} as ApiUser)
				: apiUser({ id: stringValue(raw.author_id) ?? TEST_BOT_ID, bot: true });
		const content = stringValue(raw.content) ?? '';
		const message = apiMessage({
			id: stringValue(raw.id),
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			author,
			content,
			embeds: arrayValue(raw.embeds),
			components: arrayValue(raw.components),
			attachments: normalizeAttachments(raw.attachments),
			flags: numberValue(raw.flags),
		});
		const derived = this.deriveMentions(content, raw.allowed_mentions);
		message.mention_everyone = derived.mention_everyone;
		message.mentions = derived.mentions;
		message.mention_roles = derived.mention_roles;
		if ('message_reference' in raw && raw.message_reference) {
			const ref = asRecord(raw.message_reference);
			message.message_reference = {
				...(stringValue(ref.message_id) === undefined ? {} : { message_id: stringValue(ref.message_id) }),
				...(stringValue(ref.channel_id) === undefined ? {} : { channel_id: stringValue(ref.channel_id) }),
				...(numberValue(ref.type) === undefined ? {} : { type: numberValue(ref.type) }),
			};
			const referencedId = stringValue(ref.message_id);
			const referenced = referencedId
				? this.world.messages.find(entry => entry.message.id === referencedId)?.message
				: undefined;
			if (referenced && numberValue(ref.type) === 1) {
				message.message_snapshots = [
					{
						message: {
							content: referenced.content,
							embeds: referenced.embeds,
							attachments: referenced.attachments,
							type: referenced.type,
						},
					},
				];
			} else if (referenced) {
				message.referenced_message = referenced;
			}
		}
		if ('poll' in raw && raw.poll) {
			const poll = normalizePoll(asRecord(raw.poll));
			message.poll = poll;
			const voters = new Map<number, Set<string>>();
			for (const answer of poll.answers) voters.set(answer.answer_id, new Set());
			this.pollVotersByMessage.set(this.reactionKey(channelId, message.id), voters);
		}
		this.world.messages.push({ channelId, message });
		return this.messageView(message);
	}

	/** @internal Mock internals normally call this when Discord edits a message. */
	editMessage(channelId: string, messageId: string, raw: Record<string, unknown>): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		if ('content' in raw) entry.message.content = stringValue(raw.content) ?? '';
		if ('embeds' in raw) entry.message.embeds = arrayValue(raw.embeds);
		if ('components' in raw) entry.message.components = arrayValue(raw.components);
		if ('attachments' in raw) entry.message.attachments = normalizeAttachments(raw.attachments);
		if ('flags' in raw) entry.message.flags = numberValue(raw.flags) ?? entry.message.flags;
	}

	/** @internal Mock internals normally call this when Discord deletes a message. */
	deleteMessage(channelId: string, messageId: string): void {
		this.world.messages = this.world.messages.filter(
			message => message.channelId !== channelId || message.message.id !== messageId,
		);
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
		this.pollVotersByMessage.delete(this.reactionKey(channelId, messageId));
		const pinned = this.pinnedByChannel.get(channelId);
		if (pinned) {
			const next = pinned.filter(id => id !== messageId);
			if (next.length === 0) this.pinnedByChannel.delete(channelId);
			else this.pinnedByChannel.set(channelId, next);
		}
		for (const [token, id] of this.messageIdByToken) {
			if (id === messageId) this.messageIdByToken.delete(token);
		}
	}

	private reactionKey(channelId: string, messageId: string): string {
		return `${channelId}:${messageId}`;
	}

	/** Reaction emojis arrive URL-encoded on the route (`%`-escaped); decode for stable state keys. */
	private decodeEmoji(emoji: string): string {
		if (!emoji.includes('%')) return emoji;
		try {
			return decodeURIComponent(emoji);
		} catch {
			return emoji;
		}
	}

	/** @internal Mock internals normally call this when a user reacts to a message. */
	addReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const decoded = this.decodeEmoji(emoji);
		const byEmoji = this.reactionsByMessage.get(key) ?? new Map<string, Set<string>>();
		const users = byEmoji.get(decoded) ?? new Set<string>();
		users.add(userId);
		byEmoji.set(decoded, users);
		this.reactionsByMessage.set(key, byEmoji);
	}

	/** @internal Mock internals normally call this when a user removes their reaction. */
	removeReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return;
		const decoded = this.decodeEmoji(emoji);
		const users = byEmoji.get(decoded);
		if (!users) return;
		users.delete(userId);
		if (users.size === 0) byEmoji.delete(decoded);
	}

	/** @internal Mock internals normally call this when all reactions are purged from a message. */
	removeAllReactions(channelId: string, messageId: string): void {
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
	}

	/** @internal Mock internals normally call this when one emoji's reactions are purged. */
	removeEmojiReactions(channelId: string, messageId: string, emoji: string): void {
		this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.delete(this.decodeEmoji(emoji));
	}

	/** The user ids who reacted to a message with a given emoji. */
	reactionUsers(channelId: string, messageId: string, emoji: string): string[] {
		const users = this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.get(this.decodeEmoji(emoji));
		return users ? [...users] : [];
	}

	private reactionViews(channelId: string, messageId: string): ReactionView[] {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return [];
		return [...byEmoji].map(([emoji, users]) => ({
			emoji,
			count: users.size,
			me: users.has(TEST_BOT_ID),
			users: [...users],
		}));
	}

	/** @internal Mock internals normally call this when Discord adds a member. Idempotent (replace-or-push). */
	addMember(guildId: string, raw: Record<string, unknown>): void {
		const rawUser = asRecord(raw.user);
		const userId = stringValue(rawUser.id);
		if (!userId) return;
		const disabledUntil = stringValue(raw.communication_disabled_until);
		const member = apiMember({
			user: { ...apiUser({ id: userId }), ...rawUser } as ApiUser,
			roles: arrayValue(raw.roles).map(String),
			nick: stringValue(raw.nick) ?? null,
			...(disabledUntil === undefined ? {} : { communicationDisabledUntil: disabledUntil }),
		});
		const existing = this.world.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId);
		if (existing) existing.member = member;
		else this.world.members.push({ guildId, member });
	}

	/** @internal Mock internals normally call this when Discord removes a member. */
	removeMember(guildId: string, userId: string, banned: boolean): void {
		this.world.members = this.world.members.filter(
			entry => entry.guildId !== guildId || entry.member.user.id !== userId,
		);
		if (banned) {
			const bans = this.bansByGuild.get(guildId) ?? new Set<string>();
			bans.add(userId);
			this.bansByGuild.set(guildId, bans);
		}
	}

	/** @internal Mock internals normally call this when Discord lifts a ban. */
	unban(guildId: string, userId: string): void {
		this.bansByGuild.get(guildId)?.delete(userId);
	}

	/** The user ids currently banned in a guild. */
	bans(guildId: string): string[] {
		return [...(this.bansByGuild.get(guildId) ?? new Set<string>())];
	}

	/** @internal Mock internals normally call this when Discord edits a channel. */
	editChannel(channelId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return undefined;
		if ('name' in patch) channel.name = stringValue(patch.name) ?? channel.name;
		if ('type' in patch && numberValue(patch.type) !== undefined) channel.type = numberValue(patch.type)!;
		if ('parent_id' in patch) channel.parent_id = stringValue(patch.parent_id);
		if ('permission_overwrites' in patch)
			channel.permission_overwrites = normalizeOverwrites(patch.permission_overwrites);
		if ('topic' in patch) channel.topic = stringValue(patch.topic) ?? null;
		if ('nsfw' in patch && typeof patch.nsfw === 'boolean') channel.nsfw = patch.nsfw;
		if ('rate_limit_per_user' in patch && numberValue(patch.rate_limit_per_user) !== undefined)
			channel.rate_limit_per_user = numberValue(patch.rate_limit_per_user)!;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			channel.position = numberValue(patch.position)!;
		if ('bitrate' in patch && numberValue(patch.bitrate) !== undefined) channel.bitrate = numberValue(patch.bitrate)!;
		if ('user_limit' in patch && numberValue(patch.user_limit) !== undefined)
			channel.user_limit = numberValue(patch.user_limit)!;
		if (channel.thread_metadata) {
			if ('archived' in patch && typeof patch.archived === 'boolean') channel.thread_metadata.archived = patch.archived;
			if ('locked' in patch && typeof patch.locked === 'boolean') channel.thread_metadata.locked = patch.locked;
			if ('auto_archive_duration' in patch && numberValue(patch.auto_archive_duration) !== undefined)
				channel.thread_metadata.auto_archive_duration = numberValue(patch.auto_archive_duration)!;
		}
		return { ...channel };
	}

	/** @internal Mock internals normally call this when Discord pins a message. Idempotent. */
	pinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		entry.message.pinned = true;
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		if (!ids.includes(messageId)) ids.unshift(messageId);
		this.pinnedByChannel.set(channelId, ids);
	}

	/** @internal Mock internals normally call this when Discord unpins a message. */
	unpinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (entry) entry.message.pinned = false;
		const ids = this.pinnedByChannel.get(channelId);
		if (!ids) return;
		const next = ids.filter(id => id !== messageId);
		if (next.length === 0) this.pinnedByChannel.delete(channelId);
		else this.pinnedByChannel.set(channelId, next);
	}

	/** The pinned messages of a channel, newest pin first. */
	pins(channelId: string): Record<string, unknown>[] {
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		return ids
			.map(id => this.rawMessage(channelId, id))
			.filter((message): message is Record<string, unknown> => !!message);
	}

	/** The archived threads under a channel of the given type (public = 11, private = 12). */
	archivedThreads(channelId: string, type: 'public' | 'private'): Record<string, unknown>[] {
		const threadType = type === 'private' ? 12 : 11;
		return this.world.channels
			.filter(
				channel =>
					channel.parent_id === channelId && channel.type === threadType && channel.thread_metadata?.archived === true,
			)
			.map(channel => ({ ...channel }));
	}

	/** @internal Records a vote on a poll answer; the mock exposes this via `bot.castPollVote`. */
	addPollVoter(channelId: string, messageId: string, answerId: number, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const byAnswer = this.pollVotersByMessage.get(key) ?? new Map<number, Set<string>>();
		const voters = byAnswer.get(answerId) ?? new Set<string>();
		voters.add(userId);
		byAnswer.set(answerId, voters);
		this.pollVotersByMessage.set(key, byAnswer);
		this.recountPoll(channelId, messageId);
	}

	private recountPoll(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		const poll = entry?.message.poll;
		if (!poll) return;
		const byAnswer = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId));
		poll.results.answer_counts = poll.answers.map(answer => {
			const voters = byAnswer?.get(answer.answer_id);
			return { id: answer.answer_id, count: voters?.size ?? 0, me_voted: voters?.has(TEST_BOT_ID) ?? false };
		});
	}

	/** @internal Mock internals normally call this when Discord finalizes a poll. */
	finalizePoll(channelId: string, messageId: string): Record<string, unknown> | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry?.message.poll) return undefined;
		this.recountPoll(channelId, messageId);
		entry.message.poll.results.is_finalized = true;
		return this.rawMessage(channelId, messageId);
	}

	/** The user ids who voted for a poll answer. */
	pollVoters(channelId: string, messageId: string, answerId: number): string[] {
		const voters = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId))?.get(answerId);
		return voters ? [...voters] : [];
	}

	/** @internal Mock internals normally call this when Discord rewrites member roles. */
	setMemberRoles(guildId: string, userId: string, roles: string[]): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (entry) entry.member.roles = [...roles];
	}

	/** @internal Mock internals normally call this when Discord PATCHes a member. */
	patchMember(
		guildId: string,
		userId: string,
		patch: { nick?: string | null; roles?: string[]; communication_disabled_until?: string | null },
	): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (!entry) return;
		if ('nick' in patch) entry.member.nick = patch.nick ?? null;
		if (patch.roles) entry.member.roles = [...patch.roles];
		if ('communication_disabled_until' in patch) {
			entry.member.communication_disabled_until = patch.communication_disabled_until;
		}
	}

	/** @internal Mock internals normally call this when Discord creates a role. */
	addRole(guildId: string, raw: Record<string, unknown>): ApiRole {
		const role = apiRole({
			id: stringValue(raw.id),
			name: stringValue(raw.name),
			permissions: stringValue(raw.permissions),
			position: numberValue(raw.position),
		});
		this.world.roles.push({ guildId, role });
		return role;
	}

	/** @internal Mock internals normally call this when Discord edits a role. */
	editRole(guildId: string, roleId: string, patch: Record<string, unknown>): ApiRole | undefined {
		const entry = this.world.roles.find(role => role.guildId === guildId && role.role.id === roleId);
		if (!entry) return undefined;
		if ('name' in patch) entry.role.name = stringValue(patch.name) ?? entry.role.name;
		if ('permissions' in patch) entry.role.permissions = stringValue(patch.permissions) ?? entry.role.permissions;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			entry.role.position = numberValue(patch.position)!;
		if ('color' in patch && numberValue(patch.color) !== undefined) entry.role.color = numberValue(patch.color)!;
		return { ...entry.role };
	}

	/** @internal Mock internals normally call this when Discord deletes a role. */
	removeRole(guildId: string, roleId: string): void {
		this.world.roles = this.world.roles.filter(entry => entry.guildId !== guildId || entry.role.id !== roleId);
	}

	/** @internal Mock internals normally call this when Discord edits a guild. */
	editGuild(guildId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		if ('name' in patch) guild.name = stringValue(patch.name) ?? guild.name;
		return { ...guild };
	}

	/** Whether a user is currently banned in a guild. */
	isBanned(guildId: string, userId: string): boolean {
		return this.bansByGuild.get(guildId)?.has(userId) ?? false;
	}

	/** @internal Mock internals normally call this when Discord sets a channel permission overwrite. */
	setChannelOverwrite(channelId: string, overwriteId: string, overwrite: Record<string, unknown>): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		const next: ChannelOverwriteLike = {
			id: overwriteId,
			type: numberValue(overwrite.type) ?? 0,
			allow: stringValue(overwrite.allow) ?? '0',
			deny: stringValue(overwrite.deny) ?? '0',
		};
		channel.permission_overwrites = [
			...channel.permission_overwrites.filter(current => current.id !== overwriteId),
			next,
		];
	}

	/** @internal Mock internals normally call this when Discord removes a channel permission overwrite. */
	removeChannelOverwrite(channelId: string, overwriteId: string): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		channel.permission_overwrites = channel.permission_overwrites.filter(current => current.id !== overwriteId);
	}

	/** @internal Mock internals normally call this for an interaction's first visible reply. */
	addOriginalResponse(
		token: string,
		channelId: string,
		raw: Record<string, unknown>,
		authorId: string,
	): Record<string, unknown> {
		this.registerInteractionToken(token, channelId);
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		this.messageIdByToken.set(token, view.id);
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal Mock internals normally call this for webhook edits of @original. */
	upsertOriginalResponse(token: string, raw: Record<string, unknown>, authorId: string): Record<string, unknown> {
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const messageId = this.messageIdByToken.get(token);
		if (!messageId) return this.addOriginalResponse(token, channelId, raw, authorId);
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal Mock internals normally call this for webhook edits of any interaction message. */
	editWebhookMessage(
		token: string,
		messageId: string,
		raw: Record<string, unknown>,
		authorId: string,
	): Record<string, unknown> {
		if (messageId === '@original') return this.upsertOriginalResponse(token, raw, authorId);
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal Mock internals normally call this for webhook followups. */
	addFollowup(token: string, raw: Record<string, unknown>, authorId: string): Record<string, unknown> {
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal Mock internals normally call this for webhook deletes of @original. */
	deleteOriginalResponse(token: string): void {
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		if (channelId && messageId) this.deleteMessage(channelId, messageId);
		this.messageIdByToken.delete(token);
	}

	/** @internal Mock internals normally call this for webhook deletes of any interaction message. */
	deleteWebhookMessage(token: string, messageId: string): void {
		if (messageId === '@original') {
			this.deleteOriginalResponse(token);
			return;
		}
		const channelId = this.channelIdByToken.get(token);
		if (channelId) this.deleteMessage(channelId, messageId);
	}

	private channelView(channel: ApiChannel): ChannelView {
		const channelMessages = this.world.messages.filter(message => message.channelId === channel.id);
		const messages = channelMessages.map(message => this.messageView(message.message));
		const pinnedIds = this.pinnedByChannel.get(channel.id) ?? [];
		const pins = pinnedIds
			.map(id => channelMessages.find(message => message.message.id === id))
			.filter((entry): entry is (typeof channelMessages)[number] => !!entry)
			.map(entry => this.messageView(entry.message));
		return {
			id: channel.id,
			name: channel.name,
			type: channel.type,
			parentId: channel.parent_id,
			...(channel.topic === undefined ? {} : { topic: channel.topic }),
			nsfw: channel.nsfw,
			...(channel.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: channel.rate_limit_per_user }),
			position: channel.position,
			...(channel.thread_metadata === undefined
				? {}
				: {
						archived: channel.thread_metadata.archived,
						locked: channel.thread_metadata.locked,
						threadMetadata: channel.thread_metadata,
					}),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
			messages,
			lastMessage: messages.at(-1),
			pins,
		};
	}

	private memberView(member: {
		user: ApiUser;
		roles: string[];
		nick?: string | null;
		communication_disabled_until?: string | null;
	}): GuildMemberView {
		return {
			userId: member.user.id,
			roles: [...member.roles],
			nick: member.nick,
			communicationDisabledUntil: member.communication_disabled_until,
		};
	}

	private messageView(message: ApiMessage): MessageView {
		const buttons: ButtonView[] = [];
		collectButtons(message.components, buttons);
		const reactions = this.reactionViews(message.channel_id, message.id);
		return {
			id: message.id,
			channelId: message.channel_id,
			authorId: message.author.id,
			content: message.content,
			embeds: message.embeds.map(normalizeEmbed),
			components: [...message.components],
			attachments: message.attachments.map(attachment => ({
				id: attachment.id,
				filename: attachment.filename,
				contentType: attachment.content_type,
				size: attachment.size,
				url: attachment.url,
			})),
			buttons,
			button: labelOrCustomId =>
				buttons.find(button => button.label === labelOrCustomId || button.customId === labelOrCustomId),
			reactions,
			reaction: emoji => reactions.find(entry => entry.emoji === this.decodeEmoji(emoji)),
			...(message.message_reference === undefined
				? {}
				: {
						reference: {
							...(message.message_reference.message_id === undefined
								? {}
								: { messageId: message.message_reference.message_id }),
							...(message.message_reference.channel_id === undefined
								? {}
								: { channelId: message.message_reference.channel_id }),
							...(message.message_reference.type === undefined ? {} : { type: message.message_reference.type }),
						},
					}),
			...(message.referenced_message === undefined
				? {}
				: {
						referencedMessage: {
							id: message.referenced_message.id,
							channelId: message.referenced_message.channel_id,
							authorId: message.referenced_message.author?.id,
							content: message.referenced_message.content,
						},
					}),
			...(message.poll === undefined
				? {}
				: {
						poll: {
							...(message.poll.question.text === undefined ? {} : { question: message.poll.question.text }),
							answers: message.poll.answers.map(answer => ({
								answerId: answer.answer_id,
								...(answer.poll_media.text === undefined ? {} : { text: answer.poll_media.text }),
							})),
							isFinalized: message.poll.results.is_finalized,
						},
					}),
		};
	}
}
