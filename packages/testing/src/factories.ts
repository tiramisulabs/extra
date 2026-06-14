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

export type MockUser = ReturnType<typeof mockUser>;
export type MockGuild = ReturnType<typeof mockGuild>;
export type MockChannel = ReturnType<typeof mockChannel>;
export type MockMember = ReturnType<typeof mockMember>;

export function mockUser(options: MockUserOptions = {}) {
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

export function mockGuild(options: MockGuildOptions = {}) {
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

export function mockChannel(options: MockChannelOptions = {}) {
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

export function mockMember(options: MockMemberOptions = {}) {
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
