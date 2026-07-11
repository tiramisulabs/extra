import { mockTimestamp } from '../id';
import { decodeEmoji } from './emoji';
import { assertNameBounds, assertSendableMessage } from './message-validation';
import {
	type ApiChannel,
	type ApiRole,
	type ApiUser,
	type ApiVoiceState,
	apiChannel,
	apiMember,
	apiMessage,
	apiRole,
	apiUser,
	apiVoiceState,
	type RawMessage,
} from './payloads';
import { apiError, ErrorCode } from './rest';
import { WorldStateReadCore } from './state-read';
import type { DerivedMentions, MessageView, ReactionView } from './state-support';
import {
	arrayValue,
	asRecord,
	normalizeAttachments,
	normalizeOverwrites,
	normalizePoll,
	normalizeThreadMetadata,
	numberValue,
	stringValue,
} from './state-support';

export abstract class WorldStateMutationCore extends WorldStateReadCore {
	/** @internal When Discord creates a channel. */
	addChannel(guildId: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
		const type = numberValue(raw.type);
		const parentId = stringValue(raw.parent_id);
		const isThread = type === 11 || type === 12 || raw.thread_metadata !== undefined;
		const channel = apiChannel({
			id: stringValue(raw.id),
			guildId: stringValue(raw.guild_id) ?? guildId ?? null,
			name: stringValue(raw.name),
			type,
			...(parentId === undefined ? {} : { parentId }),
			permissionOverwrites: normalizeOverwrites(raw.permission_overwrites),
			...(isThread ? { threadMetadata: normalizeThreadMetadata(raw.thread_metadata) } : {}),
		});
		this.world.channels.push(channel);
		return { ...channel };
	}

	/** @internal When Discord deletes a channel. */
	removeChannel(channelId: string): void {
		this.world.channels = this.world.channels.filter(channel => channel.id !== channelId);
		for (const message of this.world.messages) {
			if (message.channelId === channelId) {
				this.reactionsByMessage.delete(this.reactionKey(channelId, message.message.id));
				this.markMessageDeleted(message.message.id);
			}
		}
		this.world.messages = this.world.messages.filter(message => message.channelId !== channelId);
		this.pinnedByChannel.delete(channelId);
		this.threadMembersByChannel.delete(channelId);
		for (const [userId, dmChannelId] of this.dmChannelByUser) {
			if (dmChannelId === channelId) this.dmChannelByUser.delete(userId);
		}
	}

	/**
	 * @internal On VOICE_STATE_UPDATE. Upserts the voice state for
	 * `{guild_id, user_id}`; a null `channel_id` is a disconnect and removes the entry.
	 */
	setVoiceState(raw: Record<string, unknown>): void {
		const guildId = stringValue(raw.guild_id);
		const userId = stringValue(raw.user_id);
		if (!guildId || !userId) return;
		const states = (this.world.voiceStates ??= []);
		const channelId = 'channel_id' in raw ? (stringValue(raw.channel_id) ?? null) : null;
		if (channelId === null) {
			this.world.voiceStates = states.filter(
				entry => !(entry.guildId === guildId && entry.voiceState.user_id === userId),
			);
			return;
		}
		const voiceState: ApiVoiceState = {
			...apiVoiceState({
				userId,
				channelId,
				...(stringValue(raw.session_id) === undefined ? {} : { sessionId: stringValue(raw.session_id) }),
				...(typeof raw.deaf === 'boolean' ? { deaf: raw.deaf } : {}),
				...(typeof raw.mute === 'boolean' ? { mute: raw.mute } : {}),
				...(typeof raw.self_deaf === 'boolean' ? { selfDeaf: raw.self_deaf } : {}),
				...(typeof raw.self_mute === 'boolean' ? { selfMute: raw.self_mute } : {}),
				...(typeof raw.self_video === 'boolean' ? { selfVideo: raw.self_video } : {}),
				...(typeof raw.suppress === 'boolean' ? { suppress: raw.suppress } : {}),
			}),
			guild_id: guildId,
		};
		const existing = states.find(entry => entry.guildId === guildId && entry.voiceState.user_id === userId);
		if (existing) existing.voiceState = voiceState;
		else states.push({ guildId, voiceState });
	}

	/** @internal When Discord opens a DM. */
	registerDm(userId: string, raw: Record<string, unknown>): Record<string, unknown> {
		const channel = this.addChannel(undefined, { ...raw, type: raw.type ?? 1 });
		this.dmChannelByUser.set(userId, String(channel.id));
		return channel;
	}

	protected resolveUser(id: string): ApiUser {
		const user = this.world.users.find(entry => entry.id === id);
		if (user) return user;
		const member = this.world.members.find(entry => entry.member.user.id === id);
		return member ? member.member.user : apiUser({ id });
	}

	protected deriveMentions(content: string, allowedMentions: unknown): DerivedMentions {
		const allowed = asRecord(allowedMentions);
		const hasAllowed = allowedMentions !== undefined && allowedMentions !== null;
		const parse = Array.isArray(allowed.parse) ? (allowed.parse as unknown[]).map(String) : undefined;
		const userAllowlist = Array.isArray(allowed.users) ? (allowed.users as unknown[]).map(String) : undefined;
		const roleAllowlist = Array.isArray(allowed.roles) ? (allowed.roles as unknown[]).map(String) : undefined;

		const allowCategory = (category: string, allowlist: string[] | undefined): boolean => {
			if (allowlist) return true;
			if (parse) return parse.includes(category);
			return true;
		};

		const result: DerivedMentions = { mention_everyone: false, mentions: [], mention_roles: [] };
		if (!hasAllowed && content === '') return result;

		if (allowCategory('users', userAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (userAllowlist && !userAllowlist.includes(id)) continue;
				result.mentions.push(this.resolveUser(id));
			}
		}

		if (allowCategory('roles', roleAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@&(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (roleAllowlist && !roleAllowlist.includes(id)) continue;
				result.mention_roles.push(id);
			}
		}

		if (allowCategory('everyone', undefined) && /@everyone|@here/.test(content)) {
			result.mention_everyone = true;
		}

		return result;
	}

	/** @internal When Discord creates a message. */
	addMessage(channelId: string, raw: Record<string, unknown>): MessageView {
		assertSendableMessage(raw, 'create');
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const rawAuthor = asRecord(raw.author);
		const author: ApiUser =
			'id' in rawAuthor
				? ({
						...apiUser({ id: String(rawAuthor.id) }),
						...rawAuthor,
					} as ApiUser)
				: apiUser({ id: stringValue(raw.author_id) ?? this.botId, bot: true });
		const content = stringValue(raw.content) ?? '';
		const message = apiMessage({
			id: stringValue(raw.id),
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			author,
			content,
			embeds: arrayValue(raw.embeds),
			components: arrayValue(raw.components),
			attachments: normalizeAttachments(raw.attachments),
			flags: numberValue(raw.flags),
		});
		const derived = this.deriveMentions(content, raw.allowed_mentions);
		message.mention_everyone = derived.mention_everyone;
		message.mentions = derived.mentions;
		message.mention_roles = derived.mention_roles;
		if ('message_reference' in raw && raw.message_reference) {
			const ref = asRecord(raw.message_reference);
			message.message_reference = {
				...(stringValue(ref.message_id) === undefined ? {} : { message_id: stringValue(ref.message_id) }),
				...(stringValue(ref.channel_id) === undefined ? {} : { channel_id: stringValue(ref.channel_id) }),
				...(numberValue(ref.type) === undefined ? {} : { type: numberValue(ref.type) }),
			};
			const referencedId = stringValue(ref.message_id);
			const referencedChannelId = stringValue(ref.channel_id) ?? channelId;
			const referenced = referencedId
				? this.world.messages.find(
						entry => entry.channelId === referencedChannelId && entry.message.id === referencedId,
					)?.message
				: undefined;
			if (referencedId && !referenced && ref.fail_if_not_exists !== false) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: referenced message does not exist');
			}
			if (referenced && numberValue(ref.type) === 1) {
				message.message_snapshots = [
					{
						message: {
							content: referenced.content,
							embeds: referenced.embeds,
							attachments: referenced.attachments,
							type: referenced.type,
						},
					},
				];
			} else if (referenced) {
				message.referenced_message = referenced;
			}
		}
		if ('poll' in raw && raw.poll) {
			const poll = normalizePoll(asRecord(raw.poll));
			message.poll = poll;
			const voters = new Map<number, Set<string>>();
			for (const answer of poll.answers) voters.set(answer.answer_id, new Set());
			this.pollVotersByMessage.set(this.reactionKey(channelId, message.id), voters);
		}
		this.world.messages.push({ channelId, message });
		return this.buildMessageView(message);
	}

	/** @internal When Discord edits a message. */
	editMessage(channelId: string, messageId: string, raw: Record<string, unknown>): void {
		assertSendableMessage(raw, 'edit');
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		if ('content' in raw && raw.content !== undefined) entry.message.content = stringValue(raw.content) ?? '';
		if (raw.embeds !== undefined) entry.message.embeds = arrayValue(raw.embeds);
		if (raw.components !== undefined) entry.message.components = arrayValue(raw.components);
		if ('attachments' in raw && raw.attachments !== undefined)
			entry.message.attachments = normalizeAttachments(raw.attachments);
		if (raw.flags !== undefined) entry.message.flags = numberValue(raw.flags) ?? entry.message.flags;
		if ('content' in raw || 'allowed_mentions' in raw) {
			const derived = this.deriveMentions(entry.message.content, raw.allowed_mentions);
			entry.message.mention_everyone = derived.mention_everyone;
			entry.message.mentions = derived.mentions;
			entry.message.mention_roles = derived.mention_roles;
		}
		entry.message.edited_timestamp = new Date(
			Math.max(Date.parse(mockTimestamp()), Date.parse(entry.message.timestamp) + 1),
		).toISOString();
	}

	/** @internal When Discord deletes a message. */
	deleteMessage(channelId: string, messageId: string): void {
		this.world.messages = this.world.messages.filter(
			message => message.channelId !== channelId || message.message.id !== messageId,
		);
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
		this.pollVotersByMessage.delete(this.reactionKey(channelId, messageId));
		const pinned = this.pinnedByChannel.get(channelId);
		if (pinned) {
			const next = pinned.filter(id => id !== messageId);
			if (next.length === 0) this.pinnedByChannel.delete(channelId);
			else this.pinnedByChannel.set(channelId, next);
		}
		this.markMessageDeleted(messageId);
	}

	protected markMessageDeleted(messageId: string): void {
		for (const [token, id] of this.messageIdByToken) {
			if (id === messageId) {
				this.messageIdByToken.delete(token);
				this.deletedOriginalTokens.add(token);
			}
		}
	}

	protected reactionKey(channelId: string, messageId: string): string {
		return `${channelId}:${messageId}`;
	}

	/** @internal When a user reacts to a message. */
	addReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const decoded = decodeEmoji(emoji);
		const byEmoji = this.reactionsByMessage.get(key) ?? new Map<string, Set<string>>();
		const users = byEmoji.get(decoded) ?? new Set<string>();
		users.add(userId);
		byEmoji.set(decoded, users);
		this.reactionsByMessage.set(key, byEmoji);
	}

	/** @internal When a user removes their reaction. */
	removeReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return;
		const decoded = decodeEmoji(emoji);
		const users = byEmoji.get(decoded);
		if (!users) return;
		users.delete(userId);
		if (users.size === 0) byEmoji.delete(decoded);
	}

	/** @internal When all reactions are purged from a message. */
	removeAllReactions(channelId: string, messageId: string): void {
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
	}

	/** @internal When one emoji's reactions are purged. */
	removeEmojiReactions(channelId: string, messageId: string, emoji: string): void {
		this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.delete(decodeEmoji(emoji));
	}

	/** The user ids who reacted to a message with a given emoji. */
	reactionUsers(channelId: string, messageId: string, emoji: string): string[] {
		const users = this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.get(decodeEmoji(emoji));
		return users ? [...users] : [];
	}

	protected reactionViews(channelId: string, messageId: string): ReactionView[] {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return [];
		return [...byEmoji].map(([emoji, users]) => ({
			channelId,
			messageId,
			emoji,
			count: users.size,
			me: users.has(this.botId),
			users: [...users],
		}));
	}

	/** @internal When Discord adds a member. Idempotent (replace-or-push). */
	addMember(guildId: string, raw: Record<string, unknown>): void {
		const rawUser = asRecord(raw.user);
		const userId = stringValue(rawUser.id);
		if (!userId) return;
		const disabledUntil =
			raw.communication_disabled_until === null ? null : stringValue(raw.communication_disabled_until);
		const member = apiMember({
			user: { ...apiUser({ id: userId }), ...rawUser } as ApiUser,
			roles: arrayValue(raw.roles).map(String),
			nick: stringValue(raw.nick) ?? null,
			...('communication_disabled_until' in raw ? { communicationDisabledUntil: disabledUntil ?? null } : {}),
		});
		const existing = this.world.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId);
		if (existing) existing.member = member;
		else this.world.members.push({ guildId, member });
	}

	/** @internal When Discord removes a member. */
	removeMember(guildId: string, userId: string, banned: boolean): void {
		this.world.members = this.world.members.filter(
			entry => entry.guildId !== guildId || entry.member.user.id !== userId,
		);
		if (banned) {
			const bans = this.bansByGuild.get(guildId) ?? new Set<string>();
			bans.add(userId);
			this.bansByGuild.set(guildId, bans);
		}
	}

	/** @internal When Discord lifts a ban. */
	unban(guildId: string, userId: string): void {
		this.bansByGuild.get(guildId)?.delete(userId);
	}

	/** The user ids currently banned in a guild. */
	bans(guildId: string): string[] {
		return [...(this.bansByGuild.get(guildId) ?? new Set<string>())];
	}

	/** @internal When Discord edits a channel. */
	editChannel(channelId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 1, 100, 'channel name');
		if ('topic' in patch) assertNameBounds(patch.topic, 0, 1024, 'channel topic');
		if ('name' in patch) channel.name = stringValue(patch.name) ?? channel.name;
		if ('type' in patch && numberValue(patch.type) !== undefined) channel.type = numberValue(patch.type)!;
		if ('parent_id' in patch) channel.parent_id = stringValue(patch.parent_id);
		if ('permission_overwrites' in patch)
			channel.permission_overwrites = normalizeOverwrites(patch.permission_overwrites);
		if ('topic' in patch) channel.topic = stringValue(patch.topic) ?? null;
		if ('nsfw' in patch && typeof patch.nsfw === 'boolean') channel.nsfw = patch.nsfw;
		if ('rate_limit_per_user' in patch && numberValue(patch.rate_limit_per_user) !== undefined)
			channel.rate_limit_per_user = numberValue(patch.rate_limit_per_user)!;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			channel.position = numberValue(patch.position)!;
		if ('bitrate' in patch && numberValue(patch.bitrate) !== undefined) channel.bitrate = numberValue(patch.bitrate)!;
		if ('user_limit' in patch && numberValue(patch.user_limit) !== undefined)
			channel.user_limit = numberValue(patch.user_limit)!;
		if (channel.thread_metadata) {
			if ('archived' in patch && typeof patch.archived === 'boolean') channel.thread_metadata.archived = patch.archived;
			if ('locked' in patch && typeof patch.locked === 'boolean') channel.thread_metadata.locked = patch.locked;
			if ('auto_archive_duration' in patch && numberValue(patch.auto_archive_duration) !== undefined)
				channel.thread_metadata.auto_archive_duration = numberValue(patch.auto_archive_duration)!;
		}
		return { ...channel };
	}

	/** @internal When Discord pins a message. Idempotent. */
	pinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		entry.message.pinned = true;
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		if (!ids.includes(messageId)) ids.unshift(messageId);
		this.pinnedByChannel.set(channelId, ids);
	}

	/** @internal When Discord unpins a message. */
	unpinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (entry) entry.message.pinned = false;
		const ids = this.pinnedByChannel.get(channelId);
		if (!ids) return;
		const next = ids.filter(id => id !== messageId);
		if (next.length === 0) this.pinnedByChannel.delete(channelId);
		else this.pinnedByChannel.set(channelId, next);
	}

	/** The pinned messages of a channel, newest pin first. */
	pins(channelId: string): RawMessage[] {
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		return ids.map(id => this.rawMessage(channelId, id)).filter((message): message is RawMessage => !!message);
	}

	/** The archived threads under a channel of the given type (public = 11, protected = 12). */
	archivedThreads(channelId: string, type: 'public' | 'private'): ApiChannel[] {
		const threadType = type === 'private' ? 12 : 11;
		return this.world.channels
			.filter(
				channel =>
					channel.parent_id === channelId && channel.type === threadType && channel.thread_metadata?.archived === true,
			)
			.map(channel => ({ ...channel }));
	}

	/** @internal Records a vote on a poll answer; the mock exposes this via `bot.seedPollVote`. */
	addPollVoter(channelId: string, messageId: string, answerId: number, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const byAnswer = this.pollVotersByMessage.get(key) ?? new Map<number, Set<string>>();
		const poll = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		)?.message.poll;
		if (poll && !poll.allow_multiselect) {
			for (const answerVoters of byAnswer.values()) answerVoters.delete(userId);
		}
		const voters = byAnswer.get(answerId) ?? new Set<string>();
		voters.add(userId);
		byAnswer.set(answerId, voters);
		this.pollVotersByMessage.set(key, byAnswer);
		this.recountPoll(channelId, messageId);
	}

	protected recountPoll(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		const poll = entry?.message.poll;
		if (!poll) return;
		const byAnswer = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId));
		poll.results.answer_counts = poll.answers.map(answer => {
			const voters = byAnswer?.get(answer.answer_id);
			return { id: answer.answer_id, count: voters?.size ?? 0, me_voted: voters?.has(this.botId) ?? false };
		});
	}

	/** @internal When Discord finalizes a poll. */
	finalizePoll(channelId: string, messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry?.message.poll) return undefined;
		this.recountPoll(channelId, messageId);
		entry.message.poll.results.is_finalized = true;
		return this.rawMessage(channelId, messageId);
	}

	/** The user ids who voted for a poll answer. */
	pollVoters(channelId: string, messageId: string, answerId: number): string[] {
		const voters = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId))?.get(answerId);
		return voters ? [...voters] : [];
	}

	/** @internal When Discord rewrites member roles. */
	setMemberRoles(guildId: string, userId: string, roles: string[]): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (entry) entry.member.roles = [...roles];
	}

	/** @internal When Discord PATCHes a member. */
	patchMember(
		guildId: string,
		userId: string,
		patch: { nick?: string | null; roles?: string[]; communication_disabled_until?: string | null },
	): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (!entry) return;
		if ('nick' in patch) assertNameBounds(patch.nick, 0, 32, 'nickname');
		if ('nick' in patch) entry.member.nick = patch.nick ?? null;
		if (patch.roles) entry.member.roles = [...patch.roles];
		if ('communication_disabled_until' in patch) {
			entry.member.communication_disabled_until = patch.communication_disabled_until;
		}
	}

	/** @internal When Discord creates a role. */
	addRole(guildId: string, raw: Record<string, unknown>): ApiRole {
		const role = apiRole({
			id: stringValue(raw.id),
			name: stringValue(raw.name),
			permissions: stringValue(raw.permissions),
			position: numberValue(raw.position),
		});
		this.world.roles.push({ guildId, role });
		return role;
	}

	/** @internal When Discord edits a role. */
	editRole(guildId: string, roleId: string, patch: Record<string, unknown>): ApiRole | undefined {
		const entry = this.world.roles.find(role => role.guildId === guildId && role.role.id === roleId);
		if (!entry) return undefined;
		if ('name' in patch) entry.role.name = stringValue(patch.name) ?? entry.role.name;
		if ('permissions' in patch) entry.role.permissions = stringValue(patch.permissions) ?? entry.role.permissions;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			entry.role.position = numberValue(patch.position)!;
		if ('color' in patch && numberValue(patch.color) !== undefined) entry.role.color = numberValue(patch.color)!;
		return { ...entry.role };
	}

	/** @internal When Discord deletes a role. */
	removeRole(guildId: string, roleId: string): void {
		this.world.roles = this.world.roles.filter(entry => entry.guildId !== guildId || entry.role.id !== roleId);
		for (const entry of this.world.members) {
			if (entry.guildId === guildId) entry.member.roles = entry.member.roles.filter(id => id !== roleId);
		}
	}
}
