import { emojiPayload } from './emoji';
import { isEphemeral } from './message-flags';
import { type ApiMessage, type ApiVoiceState, apiMessage, type RawMessage } from './payloads';
import { WorldStateQueryCore } from './state-query';
import type {
	AutoModRuleSnapshot,
	BanSnapshot,
	ChannelSnapshot,
	ChannelView,
	EmojiSnapshot,
	GuildView,
	InviteSnapshot,
	MemberSnapshot,
	MessageQuery,
	MessageSnapshot,
	MessageView,
	PinSnapshot,
	PollVoterSnapshot,
	ReactionSnapshot,
	RoleSnapshot,
	RoleView,
	ScheduledEventSnapshot,
	StickerSnapshot,
	ThreadMemberSnapshot,
	VoiceStateSnapshot,
	WebhookSnapshot,
	WorldDiff,
	WorldSnapshot,
} from './state-support';
import { deepFreeze, diffEntities, roleView } from './state-support';

export abstract class WorldStateReadCore extends WorldStateQueryCore {
	protected abstract reactionKey(channelId: string, messageId: string): string;
	/**
	 * Capture the current world entities (members, channels, messages, roles, bans) as an immutable,
	 * plain-data snapshot. Deeply frozen, so later world mutations never alter a captured snapshot. Pair
	 * with {@link diff} to read state mutations declaratively instead of with field-by-field point queries.
	 */
	snapshot(): WorldSnapshot {
		const members: MemberSnapshot[] = this.world.members.map(entry => ({
			guildId: entry.guildId,
			userId: entry.member.user.id,
			roles: [...entry.member.roles],
			nick: entry.member.nick ?? null,
			communicationDisabledUntil: entry.member.communication_disabled_until ?? null,
		}));
		const channels: ChannelSnapshot[] = this.world.channels.map(channel => ({
			id: channel.id,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			name: channel.name,
			type: channel.type,
			...(channel.parent_id === undefined ? {} : { parentId: channel.parent_id }),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
			...(channel.topic === undefined ? {} : { topic: channel.topic }),
			...(channel.nsfw === undefined ? {} : { nsfw: channel.nsfw }),
			...(channel.position === undefined ? {} : { position: channel.position }),
			...(channel.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: channel.rate_limit_per_user }),
			...(channel.bitrate === undefined ? {} : { bitrate: channel.bitrate }),
			...(channel.user_limit === undefined ? {} : { userLimit: channel.user_limit }),
			...(channel.thread_metadata === undefined
				? {}
				: {
						archived: channel.thread_metadata.archived,
						locked: channel.thread_metadata.locked,
						autoArchiveDuration: channel.thread_metadata.auto_archive_duration,
					}),
		}));
		const messages: MessageSnapshot[] = this.world.messages.map(entry => ({
			id: entry.message.id,
			channelId: entry.channelId,
			authorId: entry.message.author.id,
			content: entry.message.content,
			embeds: entry.message.embeds ?? [],
			components: entry.message.components ?? [],
			flags: entry.message.flags ?? 0,
			pinned: entry.message.pinned ?? false,
		}));
		const roles: RoleSnapshot[] = this.world.roles.map(entry => ({
			guildId: entry.guildId,
			id: entry.role.id,
			name: entry.role.name,
			permissions: entry.role.permissions,
			position: entry.role.position,
			...(entry.role.color === undefined ? {} : { color: entry.role.color }),
		}));
		const bans: BanSnapshot[] = [...this.bansByGuild].flatMap(([guildId, userIds]) =>
			[...userIds].map(userId => ({ guildId, userId })),
		);
		const emojis: EmojiSnapshot[] = (this.world.guildEmojis ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.emoji.id,
			name: entry.emoji.name,
			...(entry.emoji.roles === undefined ? {} : { roles: [...entry.emoji.roles] }),
		}));
		const invites: InviteSnapshot[] = [...this.invitesByCode.values()].map(invite => ({
			code: invite.code,
			channelId: invite.channel_id,
			uses: invite.uses,
		}));
		const autoModRules: AutoModRuleSnapshot[] = (this.world.autoModRules ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.rule.id,
			name: entry.rule.name,
			enabled: entry.rule.enabled,
			...(entry.rule.trigger_type === undefined ? {} : { triggerType: entry.rule.trigger_type }),
			...(entry.rule.event_type === undefined ? {} : { eventType: entry.rule.event_type }),
			...(entry.rule.actions === undefined ? {} : { actions: entry.rule.actions }),
		}));
		const stickers: StickerSnapshot[] = (this.world.guildStickers ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.sticker.id,
			name: entry.sticker.name,
		}));
		const scheduledEvents: ScheduledEventSnapshot[] = (this.world.scheduledEvents ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.event.id,
			name: entry.event.name,
			status: entry.event.status,
			startTime: entry.event.scheduled_start_time,
			channelId: entry.event.channel_id,
		}));
		const webhooks: WebhookSnapshot[] = [...this.webhooksById.values()].map(webhook => ({
			id: webhook.id,
			channelId: webhook.channel_id,
			name: webhook.name,
		}));
		const pins: PinSnapshot[] = [...this.pinnedByChannel].flatMap(([channelId, messageIds]) =>
			messageIds.map(messageId => ({ channelId, messageId })),
		);
		const reactions: ReactionSnapshot[] = [...this.reactionsByMessage].flatMap(([key, byEmoji]) => {
			const [channelId, messageId] = key.split(':');
			return [...byEmoji].flatMap(([emoji, userIds]) =>
				[...userIds].map(userId => ({ channelId, messageId, emoji, userId })),
			);
		});
		const voiceStates: VoiceStateSnapshot[] = (this.world.voiceStates ?? []).map(entry => ({
			guildId: entry.guildId,
			userId: entry.voiceState.user_id,
			channelId: entry.voiceState.channel_id,
		}));
		const threadMembers: ThreadMemberSnapshot[] = [...this.threadMembersByChannel].flatMap(([channelId, userIds]) =>
			[...userIds].map(userId => ({ channelId, userId })),
		);
		const pollVoters: PollVoterSnapshot[] = [...this.pollVotersByMessage].flatMap(([key, byAnswer]) => {
			const [channelId, messageId] = key.split(':');
			return [...byAnswer].flatMap(([answerId, userIds]) =>
				[...userIds].map(userId => ({ channelId, messageId, answerId, userId })),
			);
		});
		return deepFreeze({
			members,
			channels,
			messages,
			roles,
			bans,
			emojis,
			invites,
			autoModRules,
			stickers,
			scheduledEvents,
			webhooks,
			pins,
			reactions,
			voiceStates,
			threadMembers,
			pollVoters,
		});
	}

	/**
	 * Compare a prior {@link WorldSnapshot} against the CURRENT world and return a structured changeset.
	 * Entities are matched by stable id (member/ban = guildId+userId, channel/message/role = id); `changed`
	 * lists entities present in both whose fields differ, naming those fields.
	 */
	diff(before: WorldSnapshot): WorldDiff {
		const after = this.snapshot();
		return {
			members: diffEntities(before.members, after.members, entity => `${entity.guildId}:${entity.userId}`),
			channels: diffEntities(before.channels, after.channels, entity => entity.id),
			messages: diffEntities(before.messages, after.messages, entity => entity.id),
			roles: diffEntities(before.roles, after.roles, entity => entity.id),
			bans: diffEntities(before.bans, after.bans, entity => `${entity.guildId}:${entity.userId}`),
			emojis: diffEntities(before.emojis, after.emojis, entity => `${entity.guildId}:${entity.id}`),
			invites: diffEntities(before.invites, after.invites, entity => entity.code),
			autoModRules: diffEntities(before.autoModRules, after.autoModRules, entity => `${entity.guildId}:${entity.id}`),
			stickers: diffEntities(before.stickers, after.stickers, entity => `${entity.guildId}:${entity.id}`),
			scheduledEvents: diffEntities(
				before.scheduledEvents,
				after.scheduledEvents,
				entity => `${entity.guildId}:${entity.id}`,
			),
			webhooks: diffEntities(before.webhooks, after.webhooks, entity => entity.id),
			pins: diffEntities(before.pins, after.pins, entity => `${entity.channelId}:${entity.messageId}`),
			reactions: diffEntities(
				before.reactions,
				after.reactions,
				entity => `${entity.channelId}:${entity.messageId}:${entity.emoji}:${entity.userId}`,
			),
			voiceStates: diffEntities(before.voiceStates, after.voiceStates, entity => `${entity.guildId}:${entity.userId}`),
			threadMembers: diffEntities(
				before.threadMembers,
				after.threadMembers,
				entity => `${entity.channelId}:${entity.userId}`,
			),
			pollVoters: diffEntities(
				before.pollVoters,
				after.pollVoters,
				entity => `${entity.channelId}:${entity.messageId}:${entity.answerId}:${entity.userId}`,
			),
		};
	}

	guild(guildId: string): GuildView | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		const guildChannels = this.world.channels.filter(channel => channel.guild_id === guild.id);
		const channels = guildChannels
			.filter(channel => !channel.thread_metadata)
			.map(channel => this.channelView(channel));
		const threads = guildChannels.filter(channel => channel.thread_metadata).map(channel => this.channelView(channel));
		const members = this.world.members
			.filter(entry => entry.guildId === guild.id)
			.map(entry => this.memberView(entry.guildId, entry.member));
		const roles = this.world.roles
			.filter(entry => entry.guildId === guild.id)
			.map(entry => roleView(entry.guildId, entry.role));
		const bans = [...(this.bansByGuild.get(guild.id) ?? new Set<string>())];
		const guildEmojis = (this.world.guildEmojis ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.emoji);
		const guildInvites = [...this.invitesByCode.values()].filter(invite => invite.guild_id === guild.id);
		const guildAutoModRules = (this.world.autoModRules ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.rule);
		const guildStickers = (this.world.guildStickers ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.sticker);
		const guildScheduledEvents = (this.world.scheduledEvents ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.event);

		return {
			id: guild.id,
			name: guild.name,
			channels,
			threads,
			members,
			roles,
			bans,
			emojis: guildEmojis.map(emoji => ({ id: emoji.id, name: emoji.name })),
			invites: guildInvites.map(invite => ({ code: invite.code, channelId: invite.channel_id, uses: invite.uses })),
			autoModRules: guildAutoModRules,
			stickers: guildStickers.map(sticker => ({ id: sticker.id, name: sticker.name })),
			scheduledEvents: guildScheduledEvents,
		};
	}

	channelById(channelId: string): ChannelView | undefined {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		return channel ? this.channelView(channel) : undefined;
	}

	roleById(roleId: string): RoleView | undefined {
		const entry = this.world.roles.find(entry => entry.role.id === roleId);
		return entry ? roleView(entry.guildId, entry.role) : undefined;
	}

	voiceState(guildId: string, userId: string): ApiVoiceState | undefined {
		return this.world.voiceStates?.find(entry => entry.guildId === guildId && entry.voiceState.user_id === userId)
			?.voiceState;
	}

	dm(userId: string): ChannelView | undefined {
		const channelId = this.dmChannelByUser.get(userId);
		const channel = channelId ? this.world.channels.find(entry => entry.id === channelId) : undefined;
		return channel ? this.channelView(channel) : undefined;
	}

	channelMessages(channelId: string, options?: MessageQuery): RawMessage[] {
		const chronological = this.world.messages
			.filter(entry => entry.channelId === channelId && !isEphemeral(entry.message))
			.map(entry => entry.message);
		const newestFirst = [...chronological].reverse();
		const limit = Math.min(Math.max(options?.limit ?? 50, 0), 100);

		if (options?.after !== undefined) {
			const index = chronological.findIndex(message => message.id === options.after);
			const newer = index === -1 ? newestFirst : newestFirst.filter((_, i) => i < newestFirst.length - index - 1);
			return newer.slice(-limit).map(message => ({ ...message }));
		}

		let slice = newestFirst;
		if (options?.before !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.before);
			slice = index === -1 ? newestFirst : newestFirst.slice(index + 1);
		} else if (options?.around !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.around);
			if (index !== -1) {
				const half = Math.floor(limit / 2);
				slice = newestFirst.slice(Math.max(0, index - half), index - half + limit);
			}
		}
		return slice.slice(0, limit).map(message => ({ ...message }));
	}

	rawMessage(channelId: string, messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	rawMessageById(messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(message => message.message.id === messageId);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	/** The {@link MessageView} for a stored message, or undefined when it is not in the channel. */
	messageView(channelId: string, messageId: string): MessageView | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? this.buildMessageView(entry.message) : undefined;
	}

	/** Discord reflects reactions on the message object as `{ emoji, count, me }`. */
	protected withReactions(channelId: string, message: ApiMessage): RawMessage {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, message.id));
		if (!byEmoji || byEmoji.size === 0) return { ...message };
		const reactions = [...byEmoji].map(([emoji, users]) => ({
			emoji: emojiPayload(emoji),
			count: users.size,
			me: users.has(this.botId),
		}));
		return { ...message, reactions };
	}

	protected rawMessageOr(channelId: string, messageId: string): RawMessage {
		return this.rawMessage(channelId, messageId) ?? apiMessage();
	}

	messageForToken(token: string): RawMessage | undefined {
		if (this.deletedOriginalTokens.has(token)) return undefined;
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		return channelId && messageId ? this.rawMessage(channelId, messageId) : undefined;
	}

	webhookMessage(token: string, messageId: string): RawMessage | undefined {
		if (messageId === '@original') return this.messageForToken(token);
		const channelId = this.channelIdByToken.get(token);
		return channelId ? this.rawMessage(channelId, messageId) : undefined;
	}

	channelForToken(token: string): string | undefined {
		return this.channelIdByToken.get(token);
	}

	applicationIdForToken(token: string): string | undefined {
		return this.applicationIdByToken.get(token);
	}

	registerInteractionToken(token: string, channelId: string, originType?: number, applicationId?: string): void {
		this.channelIdByToken.set(token, channelId);
		if (originType !== undefined) this.originTypeByToken.set(token, originType);
		if (applicationId !== undefined) this.applicationIdByToken.set(token, applicationId);
	}

	/** The originating interaction type (2 command, 3 component, 5 modal submit) for a token, if known. */
	interactionOrigin(token: string): number | undefined {
		return this.originTypeByToken.get(token);
	}

	/** @internal Mark an interaction acknowledged (any callback: reply/defer/update/modal). */
	acknowledgeToken(token: string): void {
		this.acknowledgedTokens.add(token);
	}

	/** Whether the interaction was acknowledged — followups/@original ops 404 until it is. */
	isAcknowledged(token: string): boolean {
		return this.acknowledgedTokens.has(token);
	}

	hasInteractionToken(token: string): boolean {
		return this.channelIdByToken.has(token);
	}

	/** @internal Point a token at an EXISTING message as its @original (deferUpdate on a component). */
	registerOriginalResponse(token: string, channelId: string, messageId: string): void {
		this.deletedOriginalTokens.delete(token);
		this.channelIdByToken.set(token, channelId);
		this.messageIdByToken.set(token, messageId);
	}

	/** @internal Record a component interaction's source message so a deferUpdate can point @original at it. */
	registerComponentSource(token: string, channelId: string, messageId: string): void {
		this.componentSourceByToken.set(token, { channelId, messageId });
	}

	/** The message a component interaction was raised on, if known. */
	componentSource(token: string): { channelId: string; messageId: string } | undefined {
		return this.componentSourceByToken.get(token);
	}
}
