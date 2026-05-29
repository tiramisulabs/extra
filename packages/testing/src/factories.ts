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
	user?: ReturnType<typeof createMockUser>;
	roles?: string[];
	nick?: string | null;
	joinedAt?: string;
}

export function createMockUser(options: MockUserOptions = {}) {
	return {
		id: options.id ?? '100000000000000000',
		username: options.username ?? 'slipher-test-user',
		globalName: options.globalName ?? options.username ?? 'Slipher Test User',
		bot: options.bot ?? false,
		discriminator: options.discriminator ?? '0',
		avatar: options.avatar ?? null,
	};
}

export function createMockGuild(options: MockGuildOptions = {}) {
	return {
		id: options.id ?? '200000000000000000',
		name: options.name ?? 'Slipher Test Guild',
		preferredLocale: options.preferredLocale ?? 'en-US',
		ownerId: options.ownerId ?? '100000000000000000',
	};
}

export function createMockChannel(options: MockChannelOptions = {}) {
	return {
		id: options.id ?? '300000000000000000',
		guildId: options.guildId ?? '200000000000000000',
		name: options.name ?? 'general',
		type: options.type ?? 0,
	};
}

export function createMockMember(options: MockMemberOptions = {}) {
	return {
		user: options.user ?? createMockUser(),
		roles: options.roles ?? [],
		nick: options.nick ?? null,
		joinedAt: options.joinedAt ?? new Date(0).toISOString(),
	};
}
