import { mockId, mockTimestamp } from '../id';
import { emojiPayload } from './emoji';
import {
	type ApiChannel,
	type ApiChannelOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiThreadOptions,
	type ApiUser,
	type ApiVoiceState,
	type ApiVoiceStateOptions,
	apiChannel,
	apiMember,
	apiThread,
	apiUser,
	apiVoiceState,
} from './payload-entities';

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
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

export interface MessageReactionAddEventOptions {
	guildId?: string;
	member?: ApiMember;
	messageAuthorId?: string;
	burst?: boolean;
	burstColors?: string[];
	type?: number;
}

/** Raw `d` for MESSAGE_REACTION_ADD, including Discord's guild-only member/message-author fields when known. */
export function messageReactionAddEvent(
	input: { channelId: string; messageId: string; userId: string; emoji: string },
	options: MessageReactionAddEventOptions = {},
): {
	user_id: string;
	channel_id: string;
	message_id: string;
	guild_id?: string;
	member?: ApiMember;
	emoji: ReturnType<typeof emojiPayload>;
	message_author_id?: string;
	burst: boolean;
	burst_colors: string[];
	type: number;
} {
	return {
		user_id: input.userId,
		channel_id: input.channelId,
		message_id: input.messageId,
		...(options.guildId === undefined ? {} : { guild_id: options.guildId }),
		...(options.member === undefined ? {} : { member: options.member }),
		emoji: emojiPayload(input.emoji),
		...(options.messageAuthorId === undefined ? {} : { message_author_id: options.messageAuthorId }),
		burst: options.burst ?? false,
		burst_colors: options.burstColors ?? [],
		type: options.type ?? 0,
	};
}

export type ApiMessageInput = ApiMessage | ApiMessageOptions;

function resolveMessage(input: ApiMessageInput, options: { channelId?: string; guildId?: string } = {}): ApiMessage {
	return 'channel_id' in input
		? input
		: apiMessage({
				...input,
				channelId: input.channelId ?? options.channelId,
				guildId: input.guildId ?? options.guildId,
			});
}

/** Raw `d` for MESSAGE_CREATE. */
export function messageCreateEvent(
	input: ApiMessageInput,
	options: { channelId?: string; guildId?: string } = {},
): ApiMessage {
	return resolveMessage(input, options);
}

/** Raw `d` for MESSAGE_DELETE. */
export function messageDeleteEvent(input: { messageId: string; channelId: string; guildId?: string }): {
	id: string;
	channel_id: string;
	guild_id?: string;
} {
	return {
		id: input.messageId,
		channel_id: input.channelId,
		...opt('guild_id', input.guildId),
	};
}

export type ApiChannelInput = ApiChannel | ApiChannelOptions;

function resolveChannel(input: ApiChannelInput): ApiChannel {
	return 'guild_id' in input || 'permission_overwrites' in input ? (input as ApiChannel) : apiChannel(input);
}

/** Raw `d` for CHANNEL_CREATE. */
export function channelCreateEvent(input: ApiChannelInput): ApiChannel {
	return resolveChannel(input);
}

/** Raw `d` for CHANNEL_DELETE. */
export function channelDeleteEvent(
	input: ApiChannel | string,
	options: { guildId?: string } = {},
): {
	id: string;
	guild_id?: string;
} {
	return typeof input === 'string'
		? { id: input, ...opt('guild_id', options.guildId) }
		: { id: input.id, ...opt('guild_id', input.guild_id ?? options.guildId) };
}

/** Raw `d` for THREAD_CREATE. */
export function threadCreateEvent(input: ApiChannel | ApiThreadOptions): ApiChannel {
	return 'guild_id' in input || 'permission_overwrites' in input ? (input as ApiChannel) : apiThread(input);
}

/** Raw `d` for THREAD_DELETE. */
export function threadDeleteEvent(
	input: ApiChannel | string,
	options: { guildId?: string; parentId?: string } = {},
): {
	id: string;
	guild_id?: string;
	parent_id?: string;
} {
	return typeof input === 'string'
		? { id: input, ...opt('guild_id', options.guildId), ...opt('parent_id', options.parentId) }
		: { id: input.id, ...opt('guild_id', input.guild_id ?? options.guildId), ...opt('parent_id', input.parent_id) };
}

/** Raw `d` for VOICE_STATE_UPDATE. */
export function voiceStateUpdateEvent(
	input: ApiVoiceState | ApiVoiceStateOptions,
	options: { guildId?: string } = {},
): ApiVoiceState & { guild_id?: string } {
	const voiceState = 'user_id' in input ? input : apiVoiceState(input);
	return { ...voiceState, ...opt('guild_id', voiceState.guild_id ?? options.guildId) };
}

export interface MessageReactionEventInput {
	channelId: string;
	messageId: string;
	emoji: string;
	userId?: string;
	guildId?: string;
}

/** Raw `d` for MESSAGE_REACTION_REMOVE. */
export function messageReactionRemoveEvent(
	input: Required<Pick<MessageReactionEventInput, 'userId'>> & MessageReactionEventInput,
): {
	user_id: string;
	channel_id: string;
	message_id: string;
	guild_id?: string;
	emoji: ReturnType<typeof emojiPayload>;
} {
	return {
		user_id: input.userId,
		channel_id: input.channelId,
		message_id: input.messageId,
		...opt('guild_id', input.guildId),
		emoji: emojiPayload(input.emoji),
	};
}

/** Raw `d` for MESSAGE_REACTION_REMOVE_ALL. */
export function messageReactionRemoveAllEvent(input: Omit<MessageReactionEventInput, 'emoji' | 'userId'>): {
	channel_id: string;
	message_id: string;
	guild_id?: string;
} {
	return {
		channel_id: input.channelId,
		message_id: input.messageId,
		...opt('guild_id', input.guildId),
	};
}

/** Raw `d` for MESSAGE_REACTION_REMOVE_EMOJI. */
export function messageReactionRemoveEmojiEvent(input: Omit<MessageReactionEventInput, 'userId'>): {
	channel_id: string;
	message_id: string;
	guild_id?: string;
	emoji: ReturnType<typeof emojiPayload>;
} {
	return {
		channel_id: input.channelId,
		message_id: input.messageId,
		...opt('guild_id', input.guildId),
		emoji: emojiPayload(input.emoji),
	};
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
	edited_timestamp: string | null;
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
		...opt('guild_id', options.guildId),
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
		...opt('poll', options.poll),
		pinned: false,
		type: 0,
		flags: options.flags ?? 0,
	};
}

/** An {@link ApiMessage} as the world readers return it: the stored message plus any reflected reactions. */
export type RawMessage = ApiMessage & {
	reactions?: { emoji: { name: string; id: string | null }; count: number; me: boolean }[];
};

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
	duration?: number;
	allowMultiselect?: boolean;
	layoutType?: number;
}

function timestampAfterHours(hours: number): string {
	return new Date(Date.parse(mockTimestamp()) + hours * 60 * 60 * 1000).toISOString();
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
		expiry:
			options.expiry ?? (options.duration === undefined ? mockTimestamp() : timestampAfterHours(options.duration)),
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
