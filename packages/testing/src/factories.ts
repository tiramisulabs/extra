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
	return {
		id: options.id ?? mockId(),
		username: options.username ?? 'slipher-test-user',
		globalName: 'globalName' in options ? options.globalName : (options.username ?? 'Slipher Test User'),
		bot: options.bot ?? false,
		discriminator: options.discriminator ?? '0',
		avatar: options.avatar ?? null,
	};
}

export function mockGuild(options: MockGuildOptions = {}) {
	return {
		id: options.id ?? mockId(),
		name: options.name ?? 'Slipher Test Guild',
		preferredLocale: options.preferredLocale ?? 'en-US',
		ownerId: options.ownerId ?? mockId(),
	};
}

export function mockChannel(options: MockChannelOptions = {}) {
	return {
		id: options.id ?? mockId(),
		guildId: options.guildId === undefined ? mockId() : options.guildId,
		name: options.name ?? 'general',
		type: options.type ?? 0,
	};
}

export function mockMember(options: MockMemberOptions = {}) {
	return {
		user: options.user ?? mockUser(),
		roles: options.roles ?? [],
		nick: options.nick ?? null,
		joinedAt: options.joinedAt ?? new Date(0).toISOString(),
	};
}
