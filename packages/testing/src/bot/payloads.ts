import { mockId, mockTimestamp } from '../id';
import type { ChannelOverwriteLike } from './permissions';

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

export interface ApiRoleOptions {
	id?: string;
	name?: string;
	permissions?: string;
	position?: number;
}

export interface ApiRole {
	id: string;
	name: string;
	permissions: string;
	position: number;
	color: number;
	colors: { primary_color: number; secondary_color: number | null; tertiary_color: number | null };
	flags: number;
	hoist: boolean;
	managed: boolean;
	mentionable: boolean;
}

export function apiRole(options: ApiRoleOptions = {}): ApiRole {
	return {
		id: options.id ?? mockId(),
		name: options.name ?? 'slipher-test-role',
		permissions: options.permissions ?? '0',
		position: options.position ?? 0,
		color: 0,
		colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
		flags: 0,
		hoist: false,
		managed: false,
		mentionable: false,
	};
}

export interface ApiChannelOptions {
	id?: string;
	guildId?: string | null;
	name?: string;
	type?: number;
	parentId?: string;
	permissionOverwrites?: ChannelOverwriteLike[];
}

export interface ApiChannel {
	id: string;
	type: number;
	name: string;
	guild_id?: string;
	parent_id?: string;
	position: number;
	permission_overwrites: ChannelOverwriteLike[];
	nsfw: boolean;
}

export function apiChannel(options: ApiChannelOptions = {}): ApiChannel {
	const guildId = options.guildId === undefined ? mockId() : options.guildId;
	return {
		id: options.id ?? mockId(),
		type: options.type ?? 0,
		name: options.name ?? 'general',
		...(guildId === null ? {} : { guild_id: guildId }),
		...(options.parentId === undefined ? {} : { parent_id: options.parentId }),
		position: 0,
		permission_overwrites: options.permissionOverwrites ?? [],
		nsfw: false,
	};
}

export interface ApiMemberOptions {
	user?: ApiUser;
	nick?: string | null;
	roles?: string[];
	joinedAt?: string;
	permissions?: string;
	communicationDisabledUntil?: string | null;
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
	communication_disabled_until?: string | null;
}

export function apiMember(options: ApiMemberOptions = {}): ApiMember {
	return {
		user: options.user ?? apiUser(),
		nick: options.nick ?? null,
		roles: options.roles ?? [],
		joined_at: options.joinedAt ?? mockTimestamp(),
		deaf: false,
		mute: false,
		flags: 0,
		...(options.permissions === undefined ? {} : { permissions: options.permissions }),
		...(options.communicationDisabledUntil === undefined
			? {}
			: { communication_disabled_until: options.communicationDisabledUntil }),
	};
}

export interface ApiVoiceStateOptions {
	userId?: string;
	channelId?: string | null;
	sessionId?: string;
	deaf?: boolean;
	mute?: boolean;
	selfDeaf?: boolean;
	selfMute?: boolean;
	selfVideo?: boolean;
	suppress?: boolean;
}

export interface ApiVoiceState {
	guild_id?: string;
	channel_id: string | null;
	user_id: string;
	session_id: string;
	deaf: boolean;
	mute: boolean;
	self_deaf: boolean;
	self_mute: boolean;
	self_video: boolean;
	self_stream: boolean;
	suppress: boolean;
	request_to_speak_timestamp: string | null;
}

export function apiVoiceState(options: ApiVoiceStateOptions = {}): ApiVoiceState {
	return {
		user_id: options.userId ?? mockId(),
		channel_id: options.channelId ?? null,
		session_id: options.sessionId ?? mockId(),
		deaf: options.deaf ?? false,
		mute: options.mute ?? false,
		self_deaf: options.selfDeaf ?? false,
		self_mute: options.selfMute ?? false,
		self_video: options.selfVideo ?? false,
		self_stream: false,
		suppress: options.suppress ?? false,
		request_to_speak_timestamp: null,
	};
}

export interface MemberEventOptions {
	guildId: string;
}

function resolveMember(member: ApiMember | ApiMemberOptions): ApiMember {
	return 'user' in member && member.user ? (member as ApiMember) : apiMember(member as ApiMemberOptions);
}

/** Raw `d` for GUILD_MEMBER_ADD: a full member plus guild_id. */
export function memberAddEvent(
	member: ApiMember | ApiMemberOptions,
	options: MemberEventOptions,
): ApiMember & { guild_id: string } {
	return { ...resolveMember(member), guild_id: options.guildId };
}

export interface MemberUpdateEventOptions extends MemberEventOptions {
	roles?: string[];
	nick?: string | null;
}

/** Raw `d` for GUILD_MEMBER_UPDATE: member fields (no deaf/mute) plus guild_id. */
export function memberUpdateEvent(
	member: ApiMember | ApiMemberOptions,
	options: MemberUpdateEventOptions,
): Omit<ApiMember, 'deaf' | 'mute'> & { guild_id: string } {
	const { deaf: _deaf, mute: _mute, ...rest } = resolveMember(member);
	return {
		...rest,
		...(options.roles ? { roles: options.roles } : {}),
		...(options.nick !== undefined ? { nick: options.nick } : {}),
		guild_id: options.guildId,
	};
}

/** Raw `d` for GUILD_MEMBER_REMOVE: the removed user plus guild_id. */
export function memberRemoveEvent(user: ApiUser, options: MemberEventOptions): { user: ApiUser; guild_id: string } {
	return { user, guild_id: options.guildId };
}

export interface ApiMessageOptions {
	id?: string;
	channelId?: string;
	guildId?: string;
	author?: ApiUser;
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
	flags?: number;
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
	mentions: unknown[];
	mention_roles: string[];
	attachments: unknown[];
	embeds: unknown[];
	components: unknown[];
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
		timestamp: mockTimestamp(),
		edited_timestamp: null,
		tts: false,
		mention_everyone: false,
		mentions: [],
		mention_roles: [],
		attachments: [],
		embeds: options.embeds ?? [],
		components: options.components ?? [],
		pinned: false,
		type: 0,
		flags: options.flags ?? 0,
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
