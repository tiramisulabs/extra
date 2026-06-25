import { CDNRouter, type CDNUrlOptions, calculateUserDefaultAvatarIndex, Formatter } from 'seyfert';
import { PermissionsBitField } from 'seyfert/lib/structures/extra/Permissions';
import { ChannelType } from 'seyfert/lib/types';
import { mockId, timestampFrom } from './id';

/** Pure, stateless CDN string builder — `CDNRouter.createProxy()` needs no rest client (mirrors `rest.cdn`). */
const cdn = () => CDNRouter.createProxy();

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
	banner?: string | null;
	avatarDecorationData?: { asset: string } | null;
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
	/** The member's guild id — used for `roles.keys` (the @everyone role == guild id). */
	guildId?: string;
	/** Role objects so `roles.list()/permissions()/sorted()/highest()` resolve; without it they throw a directed error. */
	roleData?: ApiRoleLike[];
	/** ISO timestamp the member's timeout expires; mirrors `communication_disabled_until`. Omitted/null = no timeout. */
	communicationDisabledUntil?: string | null;
}

/** The raw role fields seyfert's `member.roles` resolution reads (a subset of APIRole). */
export interface ApiRoleLike {
	id: string;
	permissions?: string;
	position?: number;
	name?: string;
}

/**
 * seyfert's `GuildMember.roles` manager. `keys` is pure (`[...roleIds, guildId]`). `list`/`permissions`/`sorted`/
 * `highest` resolve from {@link MockMemberOptions.roleData} and throw a directed error when it's absent (the light
 * harness has no role source). `add`/`remove` mutate the member's local role set.
 */
export interface MockMemberRoles {
	readonly keys: readonly string[];
	list(force?: boolean): Promise<ApiRoleLike[]>;
	permissions(force?: boolean): Promise<PermissionsBitField>;
	sorted(force?: boolean): Promise<ApiRoleLike[]>;
	highest(force?: boolean): Promise<ApiRoleLike | undefined>;
	add(id: string): Promise<void>;
	remove(id: string): Promise<void>;
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
	banner: string | null;
	avatarDecorationData: { asset: string } | null;
	/** `<@id>` mention — so `` `${user}` `` interpolates like seyfert, not `[object Object]`. */
	toString(): string;
	/** `globalName ?? username#discriminator`, mirroring seyfert's `User.tag`. */
	readonly tag: string;
	/** `globalName ?? username`, mirroring seyfert's `User.name`. */
	readonly name: string;
	/** Default avatar CDN url (from id/discriminator), via seyfert's CDN router. */
	defaultAvatarURL(): string;
	/** Avatar CDN url (or the default when no avatar hash), via seyfert's CDN router. */
	avatarURL(options?: CDNUrlOptions): string;
	/** Banner CDN url, or `undefined` when no banner — mirrors seyfert's `User.bannerURL`. */
	bannerURL(options?: CDNUrlOptions): string | undefined;
	/** Avatar-decoration CDN url, or `undefined` when none — mirrors seyfert's `User.avatarDecorationURL`. */
	avatarDecorationURL(options?: CDNUrlOptions): string | undefined;
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
	/** seyfert's role manager — `roles.keys` are the ids; see {@link MockMemberRoles}. */
	roles: MockMemberRoles;
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
	/** Guild-member avatar url; delegates to the user's avatar (seyfert's `GuildMember.avatarURL`). */
	avatarURL(options?: CDNUrlOptions & { exclude?: boolean }): string | null;
	/** Guild-member banner url; delegates to the user's banner (seyfert's `GuildMember.bannerURL`). */
	bannerURL(options?: CDNUrlOptions & { exclude?: boolean }): string | null | undefined;
	/** Delegates to the user's default avatar (seyfert's `GuildMember.defaultAvatarURL`). */
	defaultAvatarURL(): string;
	/** Ergonomic accessor; mirrors {@link communication_disabled_until}. */
	communicationDisabledUntil: string | null;
	/** Wire field; mirrors {@link communicationDisabledUntil}. */
	communication_disabled_until: string | null;
	/** Milliseconds until the timeout expires, or `false` when not timed out — seyfert's `GuildMember.hasTimeout`. */
	readonly hasTimeout: false | number;
}

export function mockUser(options: MockUserOptions = {}): MockUser {
	const id = options.id ?? mockId();
	const username = options.username ?? 'slipher-test-user';
	const globalName = options.globalName === undefined ? (options.username ?? 'Slipher Test User') : options.globalName;
	const discriminator = options.discriminator ?? '0';
	const avatar = options.avatar ?? null;
	const banner = options.banner ?? null;
	const avatarDecorationData = options.avatarDecorationData ?? null;
	const defaultAvatarURL = () => cdn().embed.avatars.get(calculateUserDefaultAvatarIndex(id, discriminator));
	return {
		id,
		username,
		globalName,
		global_name: globalName,
		bot: options.bot ?? false,
		discriminator,
		avatar,
		banner,
		avatarDecorationData,
		toString: () => Formatter.userMention(id),
		get tag() {
			return globalName ?? `${username}#${discriminator}`;
		},
		get name() {
			return globalName ?? username;
		},
		defaultAvatarURL,
		avatarURL: (avatarOptions?: CDNUrlOptions) =>
			avatar ? cdn().avatars(id).get(avatar, avatarOptions) : defaultAvatarURL(),
		bannerURL: (bannerOptions?: CDNUrlOptions) => (banner ? cdn().banners(id).get(banner, bannerOptions) : undefined),
		avatarDecorationURL: (decorationOptions?: CDNUrlOptions) =>
			avatarDecorationData
				? cdn()['avatar-decoration-presets'](avatarDecorationData.asset).get(decorationOptions)
				: undefined,
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

// seyfert's `GuildMember.roles` manager (GuildMember.js:74). `keys` pure; resolution data-backed; mutators local.
function memberRolesManager(
	roleIds: string[],
	guildId: string | undefined,
	roleData: ApiRoleLike[] | undefined,
): MockMemberRoles {
	const resolve = (method: string): ApiRoleLike[] => {
		if (!roleData) {
			throw new TypeError(
				`member.roles.${method}() can't resolve role objects on mockCommandContext (the light unit harness has ` +
					'no role source). Pass mockMember({ roleData: [{ id, permissions, position }] }), or use createMockBot.',
			);
		}
		return roleData.filter(role => roleIds.includes(role.id));
	};
	const byPosition = (method: string) => [...resolve(method)].sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
	return {
		get keys() {
			return Object.freeze(guildId ? [...roleIds, guildId] : [...roleIds]);
		},
		list: async () => resolve('list'),
		permissions: async () =>
			new PermissionsBitField(resolve('permissions').map(role => BigInt(role.permissions ?? '0'))),
		sorted: async () => byPosition('sorted'),
		highest: async () => byPosition('highest')[0],
		add: async id => {
			if (!roleIds.includes(id)) roleIds.push(id);
		},
		remove: async id => {
			const index = roleIds.indexOf(id);
			if (index !== -1) roleIds.splice(index, 1);
		},
	};
}

export function mockMember(options: MockMemberOptions = {}): MockMember {
	const user = options.user ?? mockUser();
	const joinedAt = options.joinedAt ?? new Date(0).toISOString();
	const communicationDisabledUntil = options.communicationDisabledUntil ?? null;
	const roles = memberRolesManager([...(options.roles ?? [])], options.guildId, options.roleData);
	return {
		id: user.id,
		user,
		roles,
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
		// No guild-avatar/banner field is modelled, so these take seyfert's delegating branch (GuildMember.js:147,153).
		avatarURL: avatarOptions => (avatarOptions?.exclude ? null : user.avatarURL(avatarOptions)),
		bannerURL: bannerOptions => (bannerOptions?.exclude ? null : user.bannerURL(bannerOptions)),
		defaultAvatarURL: () => user.defaultAvatarURL(),
		communicationDisabledUntil,
		communication_disabled_until: communicationDisabledUntil,
		get hasTimeout() {
			if (!communicationDisabledUntil) return false;
			const parsed = Date.parse(communicationDisabledUntil);
			const now = Date.now();
			return parsed > now ? parsed - now : false;
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
	/** Alias of {@link author}, mirroring seyfert's `Message.user`. */
	readonly user: MockUser;
	content: string;
	embeds: unknown[];
	components: unknown[];
	timestamp: string;
	tts: boolean;
	pinned: boolean;
	type: number;
	/** Jump link `https://discord.com/channels/{guild|@me}/{channel}/{id}`, via seyfert's Formatter. */
	readonly url: string;
}

/**
 * A message entity — for context-menu targets, collector/source messages, and event payloads. Mirrors the
 * camelCase + snake_case contract of the other factories.
 */
export function mockMessage(options: MockMessageOptions = {}): MockMessage {
	const id = options.id ?? mockId();
	const channelId = options.channelId ?? mockId();
	const guildId = options.guildId == null ? undefined : options.guildId;
	const author = options.author ?? mockUser();
	return {
		id,
		channelId,
		channel_id: channelId,
		...(guildId === undefined ? {} : { guildId, guild_id: guildId }),
		author,
		user: author,
		content: options.content ?? '',
		embeds: options.embeds ?? [],
		components: options.components ?? [],
		timestamp: new Date(0).toISOString(),
		tts: false,
		pinned: false,
		type: 0,
		get url() {
			return Formatter.messageLink(guildId ?? '@me', channelId, id);
		},
		...snowflakeDerived(id),
	};
}
