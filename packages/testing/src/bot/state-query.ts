import { TEST_BOT_ID } from './constants';
import { decodeEmoji } from './emoji';
import { isEphemeral } from './message-flags';
import {
	type ApiAuditLogEntry,
	type ApiAutoModRule,
	type ApiChannel,
	type ApiEmoji,
	type ApiGuildTemplate,
	type ApiInvite,
	type ApiScheduledEvent,
	type ApiSoundboardSound,
	type ApiStageInstance,
	type ApiSticker,
	type ApiVoiceState,
	type ApiWebhook,
	type RawMessage,
} from './payloads';
import type {
	BanSnapshot,
	ChannelView,
	GuildMemberView,
	GuildView,
	MessageView,
	PollVoterSnapshot,
	ReactionView,
	RoleView,
	ThreadMemberSnapshot,
	WorldAllReader,
	WorldAuditLogEntryFilter,
	WorldAutoModRuleFilter,
	WorldBanFilter,
	WorldCandidate,
	WorldChannelFilter,
	WorldDmFilter,
	WorldEmojiFilter,
	WorldGetReader,
	WorldGuildFilter,
	WorldGuildTemplateFilter,
	WorldInviteFilter,
	WorldMemberFilter,
	WorldMessageFilter,
	WorldPinFilter,
	WorldPollVoteFilter,
	WorldQueryReader,
	WorldReactionFilter,
	WorldRoleFilter,
	WorldScheduledEventFilter,
	WorldSoundboardSoundFilter,
	WorldStageInstanceFilter,
	WorldStateCandidate,
	WorldStateOptions,
	WorldStickerFilter,
	WorldThreadFilter,
	WorldThreadMemberFilter,
	WorldVoiceStateFilter,
	WorldWebhookFilter,
} from './state-support';
import { EMPTY_WORLD, queryMatches, roleView, WorldStateError } from './state-support';
import type { MockWorld } from './world';

export abstract class WorldStateQueryCore {
	protected abstract guild(guildId: string): GuildView | undefined;
	protected abstract channelView(channel: ApiChannel): ChannelView;
	protected abstract memberView(entry: MockWorld['members'][number]): GuildMemberView;
	protected abstract memberView(guildId: string, member: MockWorld['members'][number]['member']): GuildMemberView;
	protected abstract messageView(channelId: string, messageId: string): MessageView | undefined;
	protected abstract withReactions(channelId: string, message: MockWorld['messages'][number]['message']): RawMessage;
	protected abstract reactionViews(channelId: string, messageId: string): ReactionView[];
	protected abstract buildMessageView(message: MockWorld['messages'][number]['message']): MessageView;
	protected readonly world: MockWorld;
	protected readonly botId: string;
	protected readonly bansByGuild = new Map<string, Set<string>>();
	protected readonly dmChannelByUser = new Map<string, string>();
	protected readonly messageIdByToken = new Map<string, string>();
	protected readonly channelIdByToken = new Map<string, string>();
	protected readonly applicationIdByToken = new Map<string, string>();
	protected readonly originTypeByToken = new Map<string, number>();
	protected readonly acknowledgedTokens = new Set<string>();
	protected readonly deletedOriginalTokens = new Set<string>();
	protected readonly componentSourceByToken = new Map<string, { channelId: string; messageId: string }>();
	protected readonly invitesByCode = new Map<string, ApiInvite>();
	protected readonly webhooksById = new Map<string, ApiWebhook>();
	protected readonly reactionsByMessage = new Map<string, Map<string, Set<string>>>();
	protected readonly pinnedByChannel = new Map<string, string[]>();
	protected readonly pollVotersByMessage = new Map<string, Map<number, Set<string>>>();
	protected readonly threadMembersByChannel = new Map<string, Set<string>>();

	readonly get: WorldGetReader = {
		guild: query => this.expectOne('guild', query, this.guildCandidates(), this.guildCandidates(query)),
		channel: query => this.expectOne('channel', query, this.channelCandidates(), this.channelCandidates(query)),
		thread: query => this.expectOne('thread', query, this.threadCandidates(), this.threadCandidates(query)),
		dm: query => this.expectOne('dm', query, this.dmCandidates(), this.dmCandidates(query)),
		member: query => this.expectOne('member', query, this.memberCandidates(), this.memberCandidates(query)),
		role: query => this.expectOne('role', query, this.roleCandidates(), this.roleCandidates(query)),
		message: query => this.expectOne('message', query, this.messageCandidates(), this.messageCandidates(query)),
		rawMessage: query =>
			this.expectOne('rawMessage', query, this.rawMessageCandidates(), this.rawMessageCandidates(query)),
		voiceState: query =>
			this.expectOne('voiceState', query, this.voiceStateCandidates(), this.voiceStateCandidates(query)),
		ban: query => this.expectOne('ban', query, this.banCandidates(), this.banCandidates(query)),
		reaction: query => this.expectOne('reaction', query, this.reactionCandidates(), this.reactionCandidates(query)),
		pin: query => this.expectOne('pin', query, this.pinCandidates(), this.pinCandidates(query)),
		pollVote: query => this.expectOne('pollVote', query, this.pollVoteCandidates(), this.pollVoteCandidates(query)),
		threadMember: query =>
			this.expectOne('threadMember', query, this.threadMemberCandidates(), this.threadMemberCandidates(query)),
		emoji: query => this.expectOne('emoji', query, this.emojiCandidates(), this.emojiCandidates(query)),
		invite: query => this.expectOne('invite', query, this.inviteCandidates(), this.inviteCandidates(query)),
		autoModRule: query =>
			this.expectOne('autoModRule', query, this.autoModRuleCandidates(), this.autoModRuleCandidates(query)),
		sticker: query => this.expectOne('sticker', query, this.stickerCandidates(), this.stickerCandidates(query)),
		scheduledEvent: query =>
			this.expectOne('scheduledEvent', query, this.scheduledEventCandidates(), this.scheduledEventCandidates(query)),
		webhook: query => this.expectOne('webhook', query, this.webhookCandidates(), this.webhookCandidates(query)),
		guildTemplate: query =>
			this.expectOne('guildTemplate', query, this.guildTemplateCandidates(), this.guildTemplateCandidates(query)),
		soundboardSound: query =>
			this.expectOne('soundboardSound', query, this.soundboardSoundCandidates(), this.soundboardSoundCandidates(query)),
		stageInstance: query =>
			this.expectOne('stageInstance', query, this.stageInstanceCandidates(), this.stageInstanceCandidates(query)),
		auditLogEntry: query =>
			this.expectOne('auditLogEntry', query, this.auditLogEntryCandidates(), this.auditLogEntryCandidates(query)),
	};

	readonly query: WorldQueryReader = {
		guild: query => this.queryOne('guild', query, this.guildCandidates(), this.guildCandidates(query)),
		channel: query => this.queryOne('channel', query, this.channelCandidates(), this.channelCandidates(query)),
		thread: query => this.queryOne('thread', query, this.threadCandidates(), this.threadCandidates(query)),
		dm: query => this.queryOne('dm', query, this.dmCandidates(), this.dmCandidates(query)),
		member: query => this.queryOne('member', query, this.memberCandidates(), this.memberCandidates(query)),
		role: query => this.queryOne('role', query, this.roleCandidates(), this.roleCandidates(query)),
		message: query => this.queryOne('message', query, this.messageCandidates(), this.messageCandidates(query)),
		rawMessage: query =>
			this.queryOne('rawMessage', query, this.rawMessageCandidates(), this.rawMessageCandidates(query)),
		voiceState: query =>
			this.queryOne('voiceState', query, this.voiceStateCandidates(), this.voiceStateCandidates(query)),
		ban: query => this.queryOne('ban', query, this.banCandidates(), this.banCandidates(query)),
		reaction: query => this.queryOne('reaction', query, this.reactionCandidates(), this.reactionCandidates(query)),
		pin: query => this.queryOne('pin', query, this.pinCandidates(), this.pinCandidates(query)),
		pollVote: query => this.queryOne('pollVote', query, this.pollVoteCandidates(), this.pollVoteCandidates(query)),
		threadMember: query =>
			this.queryOne('threadMember', query, this.threadMemberCandidates(), this.threadMemberCandidates(query)),
		emoji: query => this.queryOne('emoji', query, this.emojiCandidates(), this.emojiCandidates(query)),
		invite: query => this.queryOne('invite', query, this.inviteCandidates(), this.inviteCandidates(query)),
		autoModRule: query =>
			this.queryOne('autoModRule', query, this.autoModRuleCandidates(), this.autoModRuleCandidates(query)),
		sticker: query => this.queryOne('sticker', query, this.stickerCandidates(), this.stickerCandidates(query)),
		scheduledEvent: query =>
			this.queryOne('scheduledEvent', query, this.scheduledEventCandidates(), this.scheduledEventCandidates(query)),
		webhook: query => this.queryOne('webhook', query, this.webhookCandidates(), this.webhookCandidates(query)),
		guildTemplate: query =>
			this.queryOne('guildTemplate', query, this.guildTemplateCandidates(), this.guildTemplateCandidates(query)),
		soundboardSound: query =>
			this.queryOne('soundboardSound', query, this.soundboardSoundCandidates(), this.soundboardSoundCandidates(query)),
		stageInstance: query =>
			this.queryOne('stageInstance', query, this.stageInstanceCandidates(), this.stageInstanceCandidates(query)),
		auditLogEntry: query =>
			this.queryOne('auditLogEntry', query, this.auditLogEntryCandidates(), this.auditLogEntryCandidates(query)),
	};

	readonly all: WorldAllReader = {
		guild: query => this.guildCandidates(query).map(candidate => candidate.value),
		channel: query => this.channelCandidates(query).map(candidate => candidate.value),
		thread: query => this.threadCandidates(query).map(candidate => candidate.value),
		dm: query => this.dmCandidates(query).map(candidate => candidate.value),
		member: query => this.memberCandidates(query).map(candidate => candidate.value),
		role: query => this.roleCandidates(query).map(candidate => candidate.value),
		message: query => this.messageCandidates(query).map(candidate => candidate.value),
		rawMessage: query => this.rawMessageCandidates(query).map(candidate => candidate.value),
		voiceState: query => this.voiceStateCandidates(query).map(candidate => candidate.value),
		ban: query => this.banCandidates(query).map(candidate => candidate.value),
		reaction: query => this.reactionCandidates(query).map(candidate => candidate.value),
		pin: query => this.pinCandidates(query).map(candidate => candidate.value),
		pollVote: query => this.pollVoteCandidates(query).map(candidate => candidate.value),
		threadMember: query => this.threadMemberCandidates(query).map(candidate => candidate.value),
		emoji: query => this.emojiCandidates(query).map(candidate => candidate.value),
		invite: query => this.inviteCandidates(query).map(candidate => candidate.value),
		autoModRule: query => this.autoModRuleCandidates(query).map(candidate => candidate.value),
		sticker: query => this.stickerCandidates(query).map(candidate => candidate.value),
		scheduledEvent: query => this.scheduledEventCandidates(query).map(candidate => candidate.value),
		webhook: query => this.webhookCandidates(query).map(candidate => candidate.value),
		guildTemplate: query => this.guildTemplateCandidates(query).map(candidate => candidate.value),
		soundboardSound: query => this.soundboardSoundCandidates(query).map(candidate => candidate.value),
		stageInstance: query => this.stageInstanceCandidates(query).map(candidate => candidate.value),
		auditLogEntry: query => this.auditLogEntryCandidates(query).map(candidate => candidate.value),
	};

	constructor(seed?: MockWorld, options: WorldStateOptions = {}) {
		this.world = seed ?? EMPTY_WORLD();
		this.botId = options.botId ?? TEST_BOT_ID;
		this.world.roles ??= [];
		this.world.messages ??= [];
		this.world.guildEmojis ??= [];
		this.world.autoModRules ??= [];
		for (const invite of this.world.invites ?? []) this.invitesByCode.set(invite.code, invite);
		for (const webhook of this.world.webhooks ?? []) this.webhooksById.set(webhook.id, webhook);
		for (const channel of this.world.channels) {
			if (channel.type === 1 && channel.id) this.dmChannelByUser.set(channel.id, channel.id);
		}
	}

	protected candidate<T>(value: T, path: string, summary?: string): WorldCandidate<T> {
		return { value, path, ...(summary === undefined ? {} : { summary }) };
	}

	protected expectOne<T>(
		entity: string,
		query: Record<string, unknown>,
		candidates: WorldCandidate<T>[],
		matches: WorldCandidate<T>[],
	): T {
		if (matches.length !== 1) {
			throw new WorldStateError(entity, query, matches.map(this.toDiagnostic), candidates.map(this.toDiagnostic));
		}
		return matches[0].value;
	}

	protected queryOne<T>(
		entity: string,
		query: Record<string, unknown>,
		candidates: WorldCandidate<T>[],
		matches: WorldCandidate<T>[],
	): T | undefined {
		if (matches.length === 0) return undefined;
		return this.expectOne(entity, query, candidates, matches);
	}

	protected toDiagnostic(candidate: WorldStateCandidate): WorldStateCandidate {
		return {
			path: candidate.path,
			...(candidate.summary === undefined ? {} : { summary: candidate.summary }),
		};
	}

	protected guildCandidates(query?: WorldGuildFilter): WorldCandidate<GuildView>[] {
		return this.world.guilds
			.map(guild => this.candidate(this.guild(guild.id)!, `guild:${guild.id}`, `name=${guild.name}`))
			.filter(candidate => queryMatches({ id: candidate.value.id, name: candidate.value.name }, query));
	}

	protected channelCandidates(query?: WorldChannelFilter): WorldCandidate<ChannelView>[] {
		return this.world.channels
			.map(channel => this.candidate(this.channelView(channel), `channel:${channel.id}`, `name=${channel.name}`))
			.filter(candidate =>
				queryMatches(
					{
						id: candidate.value.id,
						guildId: candidate.value.guildId,
						name: candidate.value.name,
						parentId: candidate.value.parentId,
						type: candidate.value.type,
						archived: candidate.value.archived,
						locked: candidate.value.locked,
					},
					query,
				),
			);
	}

	protected threadCandidates(query?: WorldThreadFilter): WorldCandidate<ChannelView>[] {
		return this.world.channels
			.filter(channel => channel.thread_metadata !== undefined || channel.type === 11 || channel.type === 12)
			.map(channel => this.candidate(this.channelView(channel), `thread:${channel.id}`, `name=${channel.name}`))
			.filter(candidate =>
				queryMatches(
					{
						id: candidate.value.id,
						guildId: candidate.value.guildId,
						name: candidate.value.name,
						parentId: candidate.value.parentId,
						type: candidate.value.type,
						archived: candidate.value.archived,
						locked: candidate.value.locked,
					},
					query,
				),
			);
	}

	protected dmCandidates(query?: WorldDmFilter): WorldCandidate<ChannelView>[] {
		const channelIdForUser = query?.userId === undefined ? undefined : this.dmChannelByUser.get(query.userId);
		return this.world.channels
			.filter(channel => channel.type === 1)
			.map(channel => this.candidate(this.channelView(channel), `dm:${channel.id}`))
			.filter(candidate => {
				if (query?.userId !== undefined && candidate.value.id !== channelIdForUser) return false;
				return queryMatches({ channelId: candidate.value.id }, { channelId: query?.channelId });
			});
	}

	protected memberCandidates(query?: WorldMemberFilter): WorldCandidate<GuildMemberView>[] {
		return this.world.members
			.map(entry =>
				this.candidate(
					this.memberView(entry.guildId, entry.member),
					`member:${entry.guildId}/${entry.member.user.id}`,
					`roles=${entry.member.roles.join(',') || '(none)'}`,
				),
			)
			.filter(candidate => {
				if (query?.roleId !== undefined && !candidate.value.roles.includes(query.roleId)) return false;
				return queryMatches(
					{
						guildId: candidate.value.guildId,
						userId: candidate.value.userId,
						nick: candidate.value.nick,
					},
					{ guildId: query?.guildId, userId: query?.userId, nick: query?.nick },
				);
			});
	}

	protected roleCandidates(query?: WorldRoleFilter): WorldCandidate<RoleView>[] {
		return this.world.roles
			.map(entry =>
				this.candidate(roleView(entry.guildId, entry.role), `role:${entry.guildId}/${entry.role.id}`, entry.role.name),
			)
			.filter(candidate =>
				queryMatches(
					{
						guildId: candidate.value.guildId,
						id: candidate.value.id,
						name: candidate.value.name,
					},
					query,
				),
			);
	}

	protected messageCandidates(query?: WorldMessageFilter): WorldCandidate<MessageView>[] {
		return this.world.messages
			.filter(entry => !isEphemeral(entry.message))
			.map(entry =>
				this.candidate(
					this.buildMessageView(entry.message),
					`message:${entry.channelId}/${entry.message.id}`,
					entry.message.content,
				),
			)
			.filter(candidate =>
				queryMatches(
					{
						channelId: candidate.value.channelId,
						id: candidate.value.id,
						authorId: candidate.value.authorId,
						content: candidate.value.content,
					},
					query,
				),
			);
	}

	protected rawMessageCandidates(query?: WorldMessageFilter): WorldCandidate<RawMessage>[] {
		return this.world.messages
			.filter(entry => !isEphemeral(entry.message))
			.map(entry =>
				this.candidate(
					this.withReactions(entry.channelId, entry.message),
					`rawMessage:${entry.channelId}/${entry.message.id}`,
					entry.message.content,
				),
			)
			.filter(candidate =>
				queryMatches(
					{
						channelId: candidate.value.channel_id,
						id: candidate.value.id,
						authorId: candidate.value.author.id,
						content: candidate.value.content,
					},
					query,
				),
			);
	}

	protected voiceStateCandidates(query?: WorldVoiceStateFilter): WorldCandidate<ApiVoiceState>[] {
		return (this.world.voiceStates ?? [])
			.filter(entry =>
				queryMatches(
					{ guildId: entry.guildId, userId: entry.voiceState.user_id, channelId: entry.voiceState.channel_id },
					query,
				),
			)
			.map(entry =>
				this.candidate(
					entry.voiceState,
					`voiceState:${entry.guildId}/${entry.voiceState.user_id}`,
					[`guildId=${entry.guildId}`, `channelId=${entry.voiceState.channel_id}`].join(' '),
				),
			);
	}

	protected banCandidates(query?: WorldBanFilter): WorldCandidate<BanSnapshot>[] {
		return [...this.bansByGuild].flatMap(([guildId, users]) =>
			[...users]
				.map(userId => this.candidate({ guildId, userId }, `ban:${guildId}/${userId}`))
				.filter(candidate => queryMatches(candidate.value, query)),
		);
	}

	protected reactionCandidates(query?: WorldReactionFilter): WorldCandidate<ReactionView>[] {
		const normalizedQuery = query?.emoji === undefined ? query : { ...query, emoji: decodeEmoji(query.emoji) };
		return this.world.messages
			.flatMap(entry => this.reactionViews(entry.channelId, entry.message.id))
			.map(reaction =>
				this.candidate(
					reaction,
					`reaction:${reaction.channelId}/${reaction.messageId}/${reaction.emoji}`,
					[`count=${reaction.count}`, `users=${reaction.users.join(',') || '(none)'}`].join(' '),
				),
			)
			.filter(candidate => {
				if (normalizedQuery?.userId !== undefined && !candidate.value.users.includes(normalizedQuery.userId)) {
					return false;
				}
				return queryMatches(
					{
						channelId: candidate.value.channelId,
						messageId: candidate.value.messageId,
						emoji: candidate.value.emoji,
					},
					{
						channelId: normalizedQuery?.channelId,
						messageId: normalizedQuery?.messageId,
						emoji: normalizedQuery?.emoji,
					},
				);
			});
	}

	protected pinCandidates(query?: WorldPinFilter): WorldCandidate<MessageView>[] {
		return [...this.pinnedByChannel].flatMap(([channelId, messageIds]) =>
			messageIds
				.map(messageId => {
					const message = this.messageView(channelId, messageId);
					return message ? this.candidate(message, `pin:${channelId}/${messageId}`, message.content) : undefined;
				})
				.filter((candidate): candidate is WorldCandidate<MessageView> => !!candidate)
				.filter(candidate =>
					queryMatches({ channelId: candidate.value.channelId, messageId: candidate.value.id }, query),
				),
		);
	}

	protected pollVoteCandidates(query?: WorldPollVoteFilter): WorldCandidate<PollVoterSnapshot>[] {
		return [...this.pollVotersByMessage].flatMap(([key, byAnswer]) => {
			const [channelId, messageId] = key.split(':');
			return [...byAnswer].flatMap(([answerId, users]) =>
				[...users]
					.map(userId =>
						this.candidate(
							{ channelId, messageId, answerId, userId },
							`pollVote:${channelId}/${messageId}/${answerId}/${userId}`,
						),
					)
					.filter(candidate => queryMatches(candidate.value, query)),
			);
		});
	}

	protected threadMemberCandidates(query?: WorldThreadMemberFilter): WorldCandidate<ThreadMemberSnapshot>[] {
		return [...this.threadMembersByChannel].flatMap(([channelId, users]) =>
			[...users]
				.map(userId => this.candidate({ channelId, userId }, `threadMember:${channelId}/${userId}`))
				.filter(candidate => queryMatches(candidate.value, query)),
		);
	}

	protected emojiCandidates(query?: WorldEmojiFilter): WorldCandidate<ApiEmoji>[] {
		return (this.world.guildEmojis ?? [])
			.filter(entry => queryMatches({ guildId: entry.guildId, id: entry.emoji.id, name: entry.emoji.name }, query))
			.map(entry => this.candidate(entry.emoji, `emoji:${entry.guildId}/${entry.emoji.id}`, entry.emoji.name));
	}

	protected inviteCandidates(query?: WorldInviteFilter): WorldCandidate<ApiInvite>[] {
		return [...this.invitesByCode.values()]
			.map(invite => this.candidate(invite, `invite:${invite.code}`, `channelId=${invite.channel_id}`))
			.filter(candidate =>
				queryMatches(
					{
						code: candidate.value.code,
						guildId: candidate.value.guild_id,
						channelId: candidate.value.channel_id,
					},
					query,
				),
			);
	}

	protected autoModRuleCandidates(query?: WorldAutoModRuleFilter): WorldCandidate<ApiAutoModRule>[] {
		return (this.world.autoModRules ?? [])
			.filter(entry => queryMatches({ guildId: entry.guildId, id: entry.rule.id, name: entry.rule.name }, query))
			.map(entry => this.candidate(entry.rule, `autoModRule:${entry.guildId}/${entry.rule.id}`, entry.rule.name));
	}

	protected stickerCandidates(query?: WorldStickerFilter): WorldCandidate<ApiSticker>[] {
		return (this.world.guildStickers ?? [])
			.filter(entry => queryMatches({ guildId: entry.guildId, id: entry.sticker.id, name: entry.sticker.name }, query))
			.map(entry => this.candidate(entry.sticker, `sticker:${entry.guildId}/${entry.sticker.id}`, entry.sticker.name));
	}

	protected scheduledEventCandidates(query?: WorldScheduledEventFilter): WorldCandidate<ApiScheduledEvent>[] {
		return (this.world.scheduledEvents ?? [])
			.filter(entry =>
				queryMatches(
					{
						guildId: entry.guildId,
						id: entry.event.id,
						name: entry.event.name,
						channelId: entry.event.channel_id,
					},
					query,
				),
			)
			.map(entry => this.candidate(entry.event, `scheduledEvent:${entry.guildId}/${entry.event.id}`, entry.event.name));
	}

	protected webhookCandidates(query?: WorldWebhookFilter): WorldCandidate<ApiWebhook>[] {
		return [...this.webhooksById.values()]
			.map(webhook => this.candidate(webhook, `webhook:${webhook.id}`, webhook.name))
			.filter(candidate =>
				queryMatches(
					{
						id: candidate.value.id,
						guildId: candidate.value.guild_id,
						channelId: candidate.value.channel_id,
						name: candidate.value.name,
					},
					query,
				),
			);
	}

	protected guildTemplateCandidates(query?: WorldGuildTemplateFilter): WorldCandidate<ApiGuildTemplate>[] {
		return (this.world.guildTemplates ?? [])
			.filter(entry =>
				queryMatches(
					{
						code: entry.template.code,
						sourceGuildId: entry.guildId,
						name: entry.template.name,
					},
					query,
				),
			)
			.map(entry =>
				this.candidate(entry.template, `guildTemplate:${entry.guildId}/${entry.template.code}`, entry.template.name),
			);
	}

	protected soundboardSoundCandidates(query?: WorldSoundboardSoundFilter): WorldCandidate<ApiSoundboardSound>[] {
		return (this.world.soundboardSounds ?? [])
			.filter(entry =>
				queryMatches(
					{
						guildId: entry.guildId,
						soundId: entry.sound.sound_id,
						name: entry.sound.name,
					},
					query,
				),
			)
			.map(entry =>
				this.candidate(entry.sound, `soundboardSound:${entry.guildId}/${entry.sound.sound_id}`, entry.sound.name),
			);
	}

	protected stageInstanceCandidates(query?: WorldStageInstanceFilter): WorldCandidate<ApiStageInstance>[] {
		return (this.world.stageInstances ?? [])
			.map(stage => this.candidate(stage, `stageInstance:${stage.channel_id}`, stage.topic))
			.filter(candidate =>
				queryMatches(
					{
						guildId: candidate.value.guild_id,
						channelId: candidate.value.channel_id,
						id: candidate.value.id,
					},
					query,
				),
			);
	}

	protected auditLogEntryCandidates(query?: WorldAuditLogEntryFilter): WorldCandidate<ApiAuditLogEntry>[] {
		return (this.world.auditLogEntries ?? [])
			.filter(entry =>
				queryMatches(
					{
						guildId: entry.guildId,
						id: entry.entry.id,
						actionType: entry.entry.action_type,
						targetId: entry.entry.target_id,
						userId: entry.entry.user_id,
					},
					query,
				),
			)
			.map(entry =>
				this.candidate(entry.entry, `auditLogEntry:${entry.guildId}/${entry.entry.id}`, `guildId=${entry.guildId}`),
			);
	}
}
