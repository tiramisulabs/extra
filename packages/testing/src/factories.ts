import { Formatter } from 'seyfert';
import { ChannelType } from 'seyfert/lib/types';
import { mockId, timestampFrom } from './id';

/** Derived from the snowflake `id`, mirroring seyfert's `DiscordBase` (so account-age/created-on logic works). */
export interface SnowflakeDerived {
	createdTimestamp: number;
	createdAt: Date;
}

/**
 * Compute the {@link SnowflakeDerived} fields for an entity whose snowflake is `id` (id is immutable). Test ids
 * aren't always real snowflakes (e.g. `'c1'`), so a non-numeric id falls back to the epoch instead of throwing.
 */
function snowflakeDerived(id: string): SnowflakeDerived {
	const createdTimestamp = /^\d+$/.test(id) ? timestampFrom(id) : 0;
	return { createdTimestamp, createdAt: new Date(createdTimestamp) };
}

export interface MockUserOptions {
	id?: string;
	username?: string;
	globalName?: string | null;
	bot?: boolean;
	discriminator?: string;
	avatar?: string | null;
}

export interface MockGuildOptions {
	id?: string;
	name?: string;
	preferredLocale?: string;
	ownerId?: string;
}

export interface MockChannelOptions {
	id?: string;
	guildId?: string | null;
	name?: string;
	type?: number;
	/**
	 * Extra fields merged onto the channel — stub the seyfert channel type-guards/methods a command calls
	 * (`isGuildTextable`, `isThread`, `isVoice`, …) without a cast. Mirrors {@link MockClientOptions.extra}.
	 */
	extra?: Record<string, unknown>;
}

export interface MockMemberOptions {
	user?: MockUser;
	roles?: string[];
	nick?: string | null;
	joinedAt?: string;
}

/**
 * Factory shapes are declared interfaces (not `ReturnType<typeof ...>`) so the public surface is an
 * intentional, documented contract instead of whatever the implementation happens to return. The
 * camelCase + snake_case pairs (e.g. `globalName`/`global_name`) are deliberate: the camelCase field is
 * the ergonomic accessor for assertions, while the snake_case field lets the factory output be dropped
 * straight into wire-shaped payloads (resolved option data, gateway `d`). Both are part of the contract.
 */
export interface MockUser extends SnowflakeDerived {
	id: string;
	username: string;
	/** Ergonomic accessor; mirrors {@link global_name}. */
	globalName: string | null;
	/** Wire field; mirrors {@link globalName}. */
	global_name: string | null;
	bot: boolean;
	discriminator: string;
	avatar: string | null;
	/** `<@id>` mention — so `` `${user}` `` interpolates like seyfert, not `[object Object]`. */
	toString(): string;
	/** `globalName ?? username#discriminator`, mirroring seyfert's `User.tag`. */
	readonly tag: string;
	/** `globalName ?? username`, mirroring seyfert's `User.name`. */
	readonly name: string;
}

export interface MockGuild extends SnowflakeDerived {
	id: string;
	name: string;
	/** Ergonomic accessor; mirrors {@link preferred_locale}. */
	preferredLocale: string;
	/** Wire field; mirrors {@link preferredLocale}. */
	preferred_locale: string;
	/** Ergonomic accessor; mirrors {@link owner_id}. */
	ownerId: string;
	/** Wire field; mirrors {@link ownerId}. */
	owner_id: string;
	icon: null;
	features: string[];
	roles: never[];
	description: null;
	verification_level: number;
	nsfw_level: number;
	premium_tier: number;
}

/**
 * seyfert's channel type-guards, implemented as pure functions of `type` (mirroring the real Channel classes).
 * A test never stubs these — set the channel `type` and the guard answers correctly. Note `isGuildTextable` is
 * true for voice/news/threads too (they carry text), per seyfert's `AllGuildTextableChannels`; `isTextGuild` is
 * the text-only check (type 0).
 */
export interface ChannelGuards {
	isStage(): boolean;
	isMedia(): boolean;
	isDM(): boolean;
	isForum(): boolean;
	isThread(): boolean;
	isDirectory(): boolean;
	isVoice(): boolean;
	isTextGuild(): boolean;
	isCategory(): boolean;
	isNews(): boolean;
	isTextable(): boolean;
	isGuildTextable(): boolean;
	isThreadOnly(): boolean;
	is(channelTypes: readonly (keyof typeof ChannelType)[]): boolean;
}

export interface MockChannel extends Record<string, unknown>, ChannelGuards, SnowflakeDerived {
	id: string;
	/** Ergonomic accessor; mirrors {@link guild_id}. `null` for a DM channel. */
	guildId: string | null;
	/** Wire field; present only for guild channels, mirroring {@link guildId}. */
	guild_id?: string;
	name: string;
	type: number;
	position: number;
	permission_overwrites: never[];
	nsfw: boolean;
	/** `<#id>` mention, via seyfert's Formatter. */
	toString(): string;
	/** `https://discord.com/channels/{guild}/{id}`, via seyfert's Formatter. */
	readonly url: string;
}

export interface MockMember extends SnowflakeDerived {
	/** The member's id — the same snowflake as its user, mirroring seyfert's `GuildMember.id`. */
	id: string;
	user: MockUser;
	roles: string[];
	nick: string | null;
	/** Ergonomic accessor; mirrors {@link joined_at}. */
	joinedAt: string;
	/** Wire field; mirrors {@link joinedAt}. */
	joined_at: string;
	deaf: boolean;
	mute: boolean;
	flags: number;
	/** `<@id>` mention, via seyfert's Formatter. */
	toString(): string;
	/** `globalName ?? username#discriminator` of the member's user, mirroring seyfert's `GuildMember.tag`. */
	readonly tag: string;
	/** `nick ?? globalName ?? username`, mirroring seyfert's `GuildMember.displayName`. */
	readonly displayName: string;
	/** `globalName ?? username` of the member's user (seyfert's `GuildMember.name`). */
	readonly name: string;
	/** The member's user's `username` (seyfert's `GuildMember.username`). */
	readonly username: string;
	/** The member's user's `globalName` (seyfert's `GuildMember.globalName`). */
	readonly globalName: string | null;
	/** Whether the member's user is a bot (seyfert's `GuildMember.bot`). */
	readonly bot: boolean;
}

export function mockUser(options: MockUserOptions = {}): MockUser {
	const id = options.id ?? mockId();
	const username = options.username ?? 'slipher-test-user';
	const globalName = options.globalName === undefined ? (options.username ?? 'Slipher Test User') : options.globalName;
	const discriminator = options.discriminator ?? '0';
	return {
		id,
		username,
		globalName,
		global_name: globalName,
		bot: options.bot ?? false,
		discriminator,
		avatar: options.avatar ?? null,
		toString: () => Formatter.userMention(id),
		get tag() {
			return globalName ?? `${username}#${discriminator}`;
		},
		get name() {
			return globalName ?? username;
		},
		...snowflakeDerived(id),
	};
}

export function mockGuild(options: MockGuildOptions = {}): MockGuild {
	const id = options.id ?? mockId();
	const ownerId = options.ownerId ?? mockId();
	const preferredLocale = options.preferredLocale ?? 'en-US';
	return {
		id,
		name: options.name ?? 'Slipher Test Guild',
		preferredLocale,
		preferred_locale: preferredLocale,
		ownerId,
		owner_id: ownerId,
		icon: null,
		features: [],
		roles: [],
		description: null,
		verification_level: 0,
		nsfw_level: 0,
		premium_tier: 0,
		...snowflakeDerived(id),
	};
}

// seyfert's guards as pure functions of `type` — mirror lib/structures/channels.js exactly.
function channelGuards(type: number): ChannelGuards {
	const isDM = type === ChannelType.DM || type === ChannelType.GroupDM;
	const isForum = type === ChannelType.GuildForum;
	const isMedia = type === ChannelType.GuildMedia;
	// `isTextable` mirrors seyfert's `'messages' in this`: AllTextableChannels = GuildText | Voice | DM | News | Thread.
	const textable = [
		ChannelType.GuildText,
		ChannelType.DM,
		ChannelType.GuildVoice,
		ChannelType.GuildAnnouncement,
		ChannelType.PublicThread,
		ChannelType.PrivateThread,
		ChannelType.AnnouncementThread,
	].includes(type);
	return {
		isStage: () => type === ChannelType.GuildStageVoice,
		isMedia: () => isMedia,
		isDM: () => isDM,
		isForum: () => isForum,
		isThread: () =>
			type === ChannelType.PublicThread ||
			type === ChannelType.PrivateThread ||
			type === ChannelType.AnnouncementThread,
		isDirectory: () => type === ChannelType.GuildDirectory,
		isVoice: () => type === ChannelType.GuildVoice,
		isTextGuild: () => type === ChannelType.GuildText,
		isCategory: () => type === ChannelType.GuildCategory,
		isNews: () => type === ChannelType.GuildAnnouncement,
		isTextable: () => textable,
		isGuildTextable: () => !isDM && textable,
		isThreadOnly: () => isForum || isMedia,
		is: channelTypes => channelTypes.some(name => ChannelType[name] === type),
	};
}

export function mockChannel(options: MockChannelOptions = {}): MockChannel {
	const id = options.id ?? mockId();
	const guildId = options.guildId === undefined ? mockId() : options.guildId;
	const type = options.type ?? 0;
	return {
		id,
		guildId,
		...(guildId === null ? {} : { guild_id: guildId }),
		name: options.name ?? 'general',
		type,
		position: 0,
		permission_overwrites: [],
		nsfw: false,
		toString: () => Formatter.channelMention(id),
		get url() {
			return Formatter.channelLink(id, guildId ?? undefined);
		},
		...channelGuards(type),
		...snowflakeDerived(id),
		...options.extra,
	};
}

export function mockMember(options: MockMemberOptions = {}): MockMember {
	const user = options.user ?? mockUser();
	const joinedAt = options.joinedAt ?? new Date(0).toISOString();
	return {
		id: user.id,
		user,
		roles: options.roles ?? [],
		nick: options.nick ?? null,
		joinedAt,
		joined_at: joinedAt,
		deaf: false,
		mute: false,
		flags: 0,
		toString: () => Formatter.userMention(user.id),
		get tag() {
			return user.tag;
		},
		get displayName() {
			return options.nick ?? user.globalName ?? user.username;
		},
		get name() {
			return user.name;
		},
		get username() {
			return user.username;
		},
		get globalName() {
			return user.globalName;
		},
		get bot() {
			return user.bot;
		},
		...snowflakeDerived(user.id),
	};
}

export interface MockMessageOptions {
	id?: string;
	channelId?: string;
	guildId?: string | null;
	author?: MockUser;
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
}

export interface MockMessage extends SnowflakeDerived {
	id: string;
	/** Ergonomic accessor; mirrors {@link channel_id}. */
	channelId: string;
	/** Wire field; mirrors {@link channelId}. */
	channel_id: string;
	/** Present only for guild messages; mirrors {@link guild_id}. */
	guildId?: string;
	/** Wire field; mirrors {@link guildId}. */
	guild_id?: string;
	author: MockUser;
	content: string;
	embeds: unknown[];
	components: unknown[];
	timestamp: string;
	tts: boolean;
	pinned: boolean;
	type: number;
}

/**
 * A message entity — for context-menu targets, collector/source messages, and event payloads. Mirrors the
 * camelCase + snake_case contract of the other factories.
 */
export function mockMessage(options: MockMessageOptions = {}): MockMessage {
	const id = options.id ?? mockId();
	const channelId = options.channelId ?? mockId();
	const guildId = options.guildId == null ? undefined : options.guildId;
	return {
		id,
		channelId,
		channel_id: channelId,
		...(guildId === undefined ? {} : { guildId, guild_id: guildId }),
		author: options.author ?? mockUser(),
		content: options.content ?? '',
		embeds: options.embeds ?? [],
		components: options.components ?? [],
		timestamp: new Date(0).toISOString(),
		tts: false,
		pinned: false,
		type: 0,
		...snowflakeDerived(id),
	};
}
