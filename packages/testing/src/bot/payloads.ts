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

export interface ApiEmojiOptions {
	id?: string;
	name?: string;
	guildId?: string;
	animated?: boolean;
	roles?: string[];
}

export interface ApiEmoji {
	id: string;
	name: string;
	guild_id?: string;
	animated: boolean;
	roles: string[];
	require_colons: boolean;
	managed: boolean;
	available: boolean;
}

export function apiEmoji(options: ApiEmojiOptions = {}): ApiEmoji {
	return {
		id: options.id ?? mockId(),
		name: options.name ?? 'slipher_test_emoji',
		...(options.guildId === undefined ? {} : { guild_id: options.guildId }),
		animated: options.animated ?? false,
		roles: options.roles ?? [],
		require_colons: true,
		managed: false,
		available: true,
	};
}

export interface ApiInviteOptions {
	code?: string;
	channelId?: string;
	guildId?: string;
	uses?: number;
	maxUses?: number;
	maxAge?: number;
	inviter?: ApiUser;
}

export interface ApiInvite {
	code: string;
	channel_id: string;
	guild_id?: string;
	uses: number;
	max_uses: number;
	max_age: number;
	temporary: boolean;
	created_at: string;
	inviter?: ApiUser;
}

export function apiInvite(options: ApiInviteOptions = {}): ApiInvite {
	return {
		code: options.code ?? mockId(),
		channel_id: options.channelId ?? mockId(),
		...(options.guildId === undefined ? {} : { guild_id: options.guildId }),
		uses: options.uses ?? 0,
		max_uses: options.maxUses ?? 0,
		max_age: options.maxAge ?? 86400,
		temporary: false,
		created_at: mockTimestamp(),
		...(options.inviter === undefined ? {} : { inviter: options.inviter }),
	};
}

export interface ThreadMetadata {
	archived: boolean;
	auto_archive_duration: number;
	locked: boolean;
	archive_timestamp: string;
}

export interface ApiChannelOptions {
	id?: string;
	guildId?: string | null;
	name?: string;
	type?: number;
	parentId?: string;
	permissionOverwrites?: ChannelOverwriteLike[];
	threadMetadata?: ThreadMetadata;
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
	topic?: string | null;
	rate_limit_per_user?: number;
	bitrate?: number;
	user_limit?: number;
	thread_metadata?: ThreadMetadata;
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
		...(options.threadMetadata === undefined ? {} : { thread_metadata: options.threadMetadata }),
	};
}

export interface ApiThreadOptions {
	id?: string;
	guildId?: string | null;
	parentId: string;
	name?: string;
	type?: number;
	archived?: boolean;
	autoArchiveDuration?: number;
	locked?: boolean;
}

/**
 * A thread is a channel of a thread type (11 PublicThread / 12 PrivateThread) that carries a `parent_id`
 * and `thread_metadata`. Built on {@link apiChannel} so threads coexist with normal channels in the same
 * collection, yet stay distinguishable by their `parent_id` + `thread_metadata`.
 */
export function apiThread(options: ApiThreadOptions): ApiChannel {
	return apiChannel({
		...(options.id === undefined ? {} : { id: options.id }),
		guildId: options.guildId,
		name: options.name ?? 'slipher-test-thread',
		type: options.type ?? 11,
		parentId: options.parentId,
		threadMetadata: {
			archived: options.archived ?? false,
			auto_archive_duration: options.autoArchiveDuration ?? 1440,
			locked: options.locked ?? false,
			archive_timestamp: mockTimestamp(),
		},
	});
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

/**
 * Single member input accepted everywhere a `member`/`targetMember` is supplied: either the loose
 * camelCase options bag (without `user`, since the dispatcher already owns the invoking user) OR a
 * full `ApiMember` as returned by {@link apiMember}. This lets `apiMember({ roles: ['r1'] })` be passed
 * as a dispatcher `member:`, a `targetMember:`, or to `actor({ member })` with no cast. Normalize with
 * {@link memberOptionsFrom} before handing it to {@link apiMember}.
 */
export type MemberInput = Omit<ApiMemberOptions, 'user'> | ApiMember;

function isApiMember(input: MemberInput): input is ApiMember {
	return 'joined_at' in input || 'user' in input;
}

/**
 * Normalize a {@link MemberInput} into the camelCase {@link ApiMemberOptions} bag that {@link apiMember}
 * consumes, mapping snake_case fields from a full `ApiMember` back to their camelCase option names. The
 * member's `user` is intentionally dropped: dispatchers set the invoking/target user themselves.
 */
export function memberOptionsFrom(input: MemberInput): Omit<ApiMemberOptions, 'user'> {
	if (!isApiMember(input)) return input;
	return {
		nick: input.nick,
		roles: input.roles,
		joinedAt: input.joined_at,
		...(input.permissions === undefined ? {} : { permissions: input.permissions }),
		...(input.communication_disabled_until === undefined
			? {}
			: { communicationDisabledUntil: input.communication_disabled_until }),
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
	attachments?: unknown[];
	poll?: ApiPoll;
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
	attachments: ApiAttachment[];
	embeds: unknown[];
	components: unknown[];
	message_reference?: { message_id?: string; channel_id?: string; type?: number };
	referenced_message?: ApiMessage;
	message_snapshots?: { message: Record<string, unknown> }[];
	poll?: ApiPoll;
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
		attachments: (options.attachments as ApiAttachment[]) ?? [],
		embeds: options.embeds ?? [],
		components: options.components ?? [],
		...(options.poll === undefined ? {} : { poll: options.poll }),
		pinned: false,
		type: 0,
		flags: options.flags ?? 0,
	};
}

export interface ApiPollMedia {
	text?: string;
	emoji?: { id: string | null; name: string | null };
}

export interface ApiPollAnswer {
	answer_id: number;
	poll_media: ApiPollMedia;
}

export interface ApiPollResults {
	is_finalized: boolean;
	answer_counts: { id: number; count: number; me_voted: boolean }[];
}

export interface ApiPoll {
	question: ApiPollMedia;
	answers: ApiPollAnswer[];
	expiry: string;
	allow_multiselect: boolean;
	layout_type: number;
	results: ApiPollResults;
}

export interface ApiPollOptions {
	question?: ApiPollMedia | string;
	answers?: (ApiPollMedia | string)[];
	expiry?: string;
	allowMultiselect?: boolean;
	layoutType?: number;
}

export function apiPoll(options: ApiPollOptions = {}): ApiPoll {
	const question: ApiPollMedia =
		typeof options.question === 'string'
			? { text: options.question }
			: (options.question ?? { text: 'slipher-test-poll' });
	const answers: ApiPollAnswer[] = (options.answers ?? []).map((answer, index) => ({
		answer_id: index + 1,
		poll_media: typeof answer === 'string' ? { text: answer } : answer,
	}));
	return {
		question,
		answers,
		expiry: options.expiry ?? mockTimestamp(),
		allow_multiselect: options.allowMultiselect ?? false,
		layout_type: options.layoutType ?? 1,
		results: {
			is_finalized: false,
			answer_counts: answers.map(answer => ({ id: answer.answer_id, count: 0, me_voted: false })),
		},
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
