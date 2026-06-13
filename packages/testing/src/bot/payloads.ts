import { mockId } from '../id';

export interface ApiUserOptions {
	id?: string;
	username?: string;
	globalName?: string | null;
	bot?: boolean;
	avatar?: string | null;
}

export interface ApiUser {
	id: string;
	username: string;
	global_name: string | null;
	discriminator: string;
	avatar: string | null;
	bot: boolean;
}

export function apiUser(options: ApiUserOptions = {}): ApiUser {
	return {
		id: options.id ?? mockId(),
		username: options.username ?? 'slipher-test-user',
		global_name: 'globalName' in options ? (options.globalName ?? null) : (options.username ?? 'Slipher Test User'),
		discriminator: '0',
		avatar: options.avatar ?? null,
		bot: options.bot ?? false,
	};
}

export interface ApiGuildOptions {
	id?: string;
	name?: string;
	ownerId?: string;
	preferredLocale?: string;
}

export interface ApiGuild {
	id: string;
	name: string;
	icon: null;
	owner_id: string;
	preferred_locale: string;
	features: string[];
	roles: never[];
	description: null;
	verification_level: number;
	nsfw_level: number;
	premium_tier: number;
}

export function apiGuild(options: ApiGuildOptions = {}): ApiGuild {
	return {
		id: options.id ?? mockId(),
		name: options.name ?? 'Slipher Test Guild',
		icon: null,
		owner_id: options.ownerId ?? mockId(),
		preferred_locale: options.preferredLocale ?? 'en-US',
		features: [],
		roles: [],
		description: null,
		verification_level: 0,
		nsfw_level: 0,
		premium_tier: 0,
	};
}

export interface ApiChannelOptions {
	id?: string;
	guildId?: string | null;
	name?: string;
	type?: number;
}

export interface ApiChannel {
	id: string;
	type: number;
	name: string;
	guild_id?: string;
	position: number;
	permission_overwrites: never[];
	nsfw: boolean;
}

export function apiChannel(options: ApiChannelOptions = {}): ApiChannel {
	const guildId = options.guildId === undefined ? mockId() : options.guildId;
	return {
		id: options.id ?? mockId(),
		type: options.type ?? 0,
		name: options.name ?? 'general',
		...(guildId === null ? {} : { guild_id: guildId }),
		position: 0,
		permission_overwrites: [],
		nsfw: false,
	};
}

export interface ApiMemberOptions {
	user?: ApiUser;
	nick?: string | null;
	roles?: string[];
	joinedAt?: string;
	permissions?: string;
}

export interface ApiMember {
	user: ApiUser;
	nick: string | null;
	roles: string[];
	joined_at: string;
	deaf: boolean;
	mute: boolean;
	flags: number;
	permissions?: string;
}

export function apiMember(options: ApiMemberOptions = {}): ApiMember {
	return {
		user: options.user ?? apiUser(),
		nick: options.nick ?? null,
		roles: options.roles ?? [],
		joined_at: options.joinedAt ?? new Date(0).toISOString(),
		deaf: false,
		mute: false,
		flags: 0,
		...(options.permissions === undefined ? {} : { permissions: options.permissions }),
	};
}

export interface ApiMessageOptions {
	id?: string;
	channelId?: string;
	guildId?: string;
	author?: ApiUser;
	content?: string;
}

export interface ApiMessage {
	id: string;
	channel_id: string;
	guild_id?: string;
	author: ApiUser;
	content: string;
	timestamp: string;
	edited_timestamp: null;
	tts: boolean;
	mention_everyone: boolean;
	mentions: never[];
	mention_roles: never[];
	attachments: never[];
	embeds: never[];
	components: never[];
	pinned: boolean;
	type: number;
	flags: number;
}

export function apiMessage(options: ApiMessageOptions = {}): ApiMessage {
	return {
		id: options.id ?? mockId(),
		channel_id: options.channelId ?? mockId(),
		...(options.guildId === undefined ? {} : { guild_id: options.guildId }),
		author: options.author ?? apiUser(),
		content: options.content ?? '',
		timestamp: new Date(0).toISOString(),
		edited_timestamp: null,
		tts: false,
		mention_everyone: false,
		mentions: [],
		mention_roles: [],
		attachments: [],
		embeds: [],
		components: [],
		pinned: false,
		type: 0,
		flags: 0,
	};
}

export interface ApiAttachmentOptions {
	id?: string;
	filename?: string;
	contentType?: string;
	size?: number;
	url?: string;
}

export interface ApiAttachment {
	id: string;
	filename: string;
	content_type: string;
	size: number;
	url: string;
	proxy_url: string;
}

export function apiAttachment(options: ApiAttachmentOptions = {}): ApiAttachment {
	const id = options.id ?? mockId();
	const filename = options.filename ?? 'slipher-test-file.png';
	const url = options.url ?? `https://cdn.slipher.test/attachments/${id}/${filename}`;
	return {
		id,
		filename,
		content_type: options.contentType ?? 'image/png',
		size: options.size ?? 1024,
		url,
		proxy_url: url,
	};
}
