import { mockId } from './id';

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
export interface MockUser {
	id: string;
	username: string;
	/** Ergonomic accessor; mirrors {@link global_name}. */
	globalName: string | null;
	/** Wire field; mirrors {@link globalName}. */
	global_name: string | null;
	bot: boolean;
	discriminator: string;
	avatar: string | null;
}

export interface MockGuild {
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

export interface MockChannel {
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
}

export interface MockMember {
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
}

export function mockUser(options: MockUserOptions = {}): MockUser {
	const globalName = options.globalName === undefined ? (options.username ?? 'Slipher Test User') : options.globalName;
	return {
		id: options.id ?? mockId(),
		username: options.username ?? 'slipher-test-user',
		globalName,
		global_name: globalName,
		bot: options.bot ?? false,
		discriminator: options.discriminator ?? '0',
		avatar: options.avatar ?? null,
	};
}

export function mockGuild(options: MockGuildOptions = {}): MockGuild {
	const ownerId = options.ownerId ?? mockId();
	const preferredLocale = options.preferredLocale ?? 'en-US';
	return {
		id: options.id ?? mockId(),
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
	};
}

export function mockChannel(options: MockChannelOptions = {}): MockChannel {
	const guildId = options.guildId === undefined ? mockId() : options.guildId;
	return {
		id: options.id ?? mockId(),
		guildId,
		...(guildId === null ? {} : { guild_id: guildId }),
		name: options.name ?? 'general',
		type: options.type ?? 0,
		position: 0,
		permission_overwrites: [],
		nsfw: false,
	};
}

export function mockMember(options: MockMemberOptions = {}): MockMember {
	const joinedAt = options.joinedAt ?? new Date(0).toISOString();
	return {
		user: options.user ?? mockUser(),
		roles: options.roles ?? [],
		nick: options.nick ?? null,
		joinedAt,
		joined_at: joinedAt,
		deaf: false,
		mute: false,
		flags: 0,
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

export interface MockMessage {
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
	const channelId = options.channelId ?? mockId();
	const guildId = options.guildId == null ? undefined : options.guildId;
	return {
		id: options.id ?? mockId(),
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
	};
}
