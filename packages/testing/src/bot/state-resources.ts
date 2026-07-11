import { mockId } from '../id';
import { decodeEmoji } from './emoji';
import { isEphemeral, MESSAGE_FLAG_COMPONENTS_V2 } from './message-flags';
import { assertNameBounds } from './message-validation';
import {
	type ApiAuditLogEntry,
	type ApiAutoModRule,
	type ApiChannel,
	type ApiEmoji,
	type ApiGuildTemplate,
	type ApiInvite,
	type ApiMessage,
	type ApiScheduledEvent,
	type ApiSoundboardSound,
	type ApiStageInstance,
	type ApiSticker,
	type ApiUser,
	type ApiWebhook,
	type AutoModAction,
	type AutoModTriggerMetadata,
	apiAutoModRule,
	apiEmoji,
	apiGuildTemplate,
	apiInvite,
	apiScheduledEvent,
	apiStageInstance,
	apiSticker,
	apiWebhook,
	type RawMessage,
} from './payloads';
import type { ChannelOverwriteLike } from './permissions';
import { apiError, ErrorCode } from './rest';
import { WorldStateMutationCore } from './state-mutations';
import type { ChannelView, GuildMemberView, MessageView } from './state-support';
import {
	arrayValue,
	asRecord,
	harvestComponents,
	listByGuild,
	normalizeEmbed,
	numberValue,
	oneByGuild,
	removeByGuild,
	stringValue,
} from './state-support';

export class WorldState extends WorldStateMutationCore {
	/** @internal When Discord creates an emoji. */
	addEmoji(guildId: string, raw: Record<string, unknown>): ApiEmoji {
		assertNameBounds(raw.name, 2, 32, 'emoji name', /^[A-Za-z0-9_]+$/);
		const emoji = apiEmoji({
			id: stringValue(raw.id),
			name: stringValue(raw.name),
			guildId,
			...(typeof raw.animated === 'boolean' ? { animated: raw.animated } : {}),
			roles: arrayValue(raw.roles).map(String),
		});
		(this.world.guildEmojis ??= []).push({ guildId, emoji });
		return emoji;
	}

	/** @internal When Discord edits an emoji. */
	editEmoji(guildId: string, emojiId: string, patch: Record<string, unknown>): ApiEmoji | undefined {
		const entry = (this.world.guildEmojis ?? []).find(e => e.guildId === guildId && e.emoji.id === emojiId);
		if (!entry) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 32, 'emoji name', /^[A-Za-z0-9_]+$/);
		if ('name' in patch) entry.emoji.name = stringValue(patch.name) ?? entry.emoji.name;
		if ('roles' in patch) entry.emoji.roles = arrayValue(patch.roles).map(String);
		return { ...entry.emoji };
	}

	/** @internal When Discord deletes an emoji. */
	removeEmoji(guildId: string, emojiId: string): void {
		this.world.guildEmojis = removeByGuild(this.world.guildEmojis, guildId, emojiId, e => e.emoji);
	}

	/** The custom emojis of a guild. */
	emojis(guildId: string): ApiEmoji[] {
		return listByGuild(this.world.guildEmojis, guildId, e => e.emoji);
	}

	/** A single guild emoji by id. */
	emoji(guildId: string, emojiId: string): ApiEmoji | undefined {
		return oneByGuild(this.world.guildEmojis, guildId, emojiId, e => e.emoji);
	}

	/** @internal When Discord creates an invite. */
	addInvite(channelId: string, guildId: string | undefined, raw: Record<string, unknown>): ApiInvite {
		const invite = apiInvite({
			code: stringValue(raw.code),
			channelId,
			...(guildId === undefined ? {} : { guildId }),
			...(numberValue(raw.max_uses) === undefined ? {} : { maxUses: numberValue(raw.max_uses) }),
			...(numberValue(raw.max_age) === undefined ? {} : { maxAge: numberValue(raw.max_age) }),
		});
		this.invitesByCode.set(invite.code, invite);
		return invite;
	}

	/** @internal When Discord revokes an invite. */
	removeInvite(code: string): ApiInvite | undefined {
		const invite = this.invitesByCode.get(code);
		this.invitesByCode.delete(code);
		return invite;
	}

	/** Every invite in the world. */
	invites(): ApiInvite[] {
		return [...this.invitesByCode.values()];
	}

	/** A single invite by code. */
	invite(code: string): ApiInvite | undefined {
		return this.invitesByCode.get(code);
	}

	/** The invites pointing at a channel. */
	channelInvites(channelId: string): ApiInvite[] {
		return [...this.invitesByCode.values()].filter(invite => invite.channel_id === channelId);
	}

	/** The invites of a guild. */
	guildInvites(guildId: string): ApiInvite[] {
		return [...this.invitesByCode.values()].filter(invite => invite.guild_id === guildId);
	}

	/** @internal When Discord creates an automod rule. */
	addAutoModRule(guildId: string, raw: Record<string, unknown>): ApiAutoModRule {
		const rule = apiAutoModRule({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(numberValue(raw.trigger_type) === undefined ? {} : { triggerType: numberValue(raw.trigger_type) }),
			...(numberValue(raw.event_type) === undefined ? {} : { eventType: numberValue(raw.event_type) }),
			...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
			...(raw.trigger_metadata === undefined
				? {}
				: { triggerMetadata: asRecord(raw.trigger_metadata) as AutoModTriggerMetadata }),
			actions: arrayValue(raw.actions) as AutoModAction[],
		});
		(this.world.autoModRules ??= []).push({ guildId, rule });
		return rule;
	}

	/** @internal When Discord edits an automod rule. */
	editAutoModRule(guildId: string, ruleId: string, patch: Record<string, unknown>): ApiAutoModRule | undefined {
		const entry = (this.world.autoModRules ?? []).find(r => r.guildId === guildId && r.rule.id === ruleId);
		if (!entry) return undefined;
		if ('name' in patch) entry.rule.name = stringValue(patch.name) ?? entry.rule.name;
		if (typeof patch.enabled === 'boolean') entry.rule.enabled = patch.enabled;
		if (numberValue(patch.trigger_type) !== undefined) entry.rule.trigger_type = numberValue(patch.trigger_type)!;
		if (numberValue(patch.event_type) !== undefined) entry.rule.event_type = numberValue(patch.event_type)!;
		if ('actions' in patch) entry.rule.actions = arrayValue(patch.actions) as AutoModAction[];
		return { ...entry.rule };
	}

	/** @internal When Discord deletes an automod rule. */
	removeAutoModRule(guildId: string, ruleId: string): void {
		this.world.autoModRules = removeByGuild(this.world.autoModRules, guildId, ruleId, r => r.rule);
	}

	/** The automod rules of a guild. */
	autoModRules(guildId: string): ApiAutoModRule[] {
		return listByGuild(this.world.autoModRules, guildId, r => r.rule);
	}

	/** A single automod rule by id. */
	autoModRule(guildId: string, ruleId: string): ApiAutoModRule | undefined {
		return oneByGuild(this.world.autoModRules, guildId, ruleId, r => r.rule);
	}

	/** @internal When a user joins a thread. Idempotent. */
	addThreadMember(channelId: string, userId: string): void {
		const set = this.threadMembersByChannel.get(channelId) ?? new Set<string>();
		set.add(userId);
		this.threadMembersByChannel.set(channelId, set);
	}

	/** @internal When a user leaves a thread. */
	removeThreadMember(channelId: string, userId: string): void {
		const set = this.threadMembersByChannel.get(channelId);
		if (!set) return;
		set.delete(userId);
		if (set.size === 0) this.threadMembersByChannel.delete(channelId);
	}

	/** The user ids currently in a thread. */
	threadMembers(channelId: string): string[] {
		return [...(this.threadMembersByChannel.get(channelId) ?? new Set<string>())];
	}

	/** The non-archived threads of a guild (the active set). */
	activeThreads(guildId: string): ApiChannel[] {
		return this.world.channels
			.filter(
				channel =>
					channel.guild_id === guildId &&
					channel.thread_metadata !== undefined &&
					channel.thread_metadata.archived !== true,
			)
			.map(channel => ({ ...channel }));
	}

	/** @internal When Discord creates a webhook. */
	registerWebhook(options: Parameters<typeof apiWebhook>[0]): ApiWebhook {
		const webhook = apiWebhook(options);
		this.webhooksById.set(webhook.id, webhook);
		return webhook;
	}

	/** @internal When Discord edits a webhook. */
	editWebhook(id: string, patch: Record<string, unknown>): ApiWebhook | undefined {
		const webhook = this.webhooksById.get(id);
		if (!webhook) return undefined;
		if ('name' in patch) webhook.name = stringValue(patch.name) ?? webhook.name;
		if ('channel_id' in patch) webhook.channel_id = stringValue(patch.channel_id) ?? webhook.channel_id;
		return { ...webhook };
	}

	/** @internal When Discord deletes a webhook. */
	removeWebhook(id: string): void {
		this.webhooksById.delete(id);
	}

	/** A webhook by id. */
	webhookById(id: string): ApiWebhook | undefined {
		return this.webhooksById.get(id);
	}

	/** The webhooks of a guild. */
	webhooksForGuild(guildId: string): ApiWebhook[] {
		return [...this.webhooksById.values()].filter(webhook => webhook.guild_id === guildId);
	}

	/** The webhooks of a channel. */
	webhooksForChannel(channelId: string): ApiWebhook[] {
		return [...this.webhooksById.values()].filter(webhook => webhook.channel_id === channelId);
	}

	/** @internal When Discord creates a sticker. */
	addSticker(guildId: string, raw: Record<string, unknown>): ApiSticker {
		assertNameBounds(raw.name, 2, 30, 'sticker name');
		const sticker = apiSticker({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(stringValue(raw.tags) === undefined ? {} : { tags: stringValue(raw.tags) }),
			...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		});
		(this.world.guildStickers ??= []).push({ guildId, sticker });
		return sticker;
	}

	/** @internal When Discord edits a sticker. */
	editSticker(guildId: string, stickerId: string, patch: Record<string, unknown>): ApiSticker | undefined {
		const entry = (this.world.guildStickers ?? []).find(s => s.guildId === guildId && s.sticker.id === stickerId);
		if (!entry) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 30, 'sticker name');
		if ('name' in patch) entry.sticker.name = stringValue(patch.name) ?? entry.sticker.name;
		if ('tags' in patch) entry.sticker.tags = stringValue(patch.tags) ?? entry.sticker.tags;
		if ('description' in patch) entry.sticker.description = stringValue(patch.description) ?? null;
		return { ...entry.sticker };
	}

	/** @internal When Discord deletes a sticker. */
	removeSticker(guildId: string, stickerId: string): void {
		this.world.guildStickers = removeByGuild(this.world.guildStickers, guildId, stickerId, s => s.sticker);
	}

	/** The custom stickers of a guild. */
	stickers(guildId: string): ApiSticker[] {
		return listByGuild(this.world.guildStickers, guildId, s => s.sticker);
	}

	/** A single guild sticker by id. */
	sticker(guildId: string, stickerId: string): ApiSticker | undefined {
		return oneByGuild(this.world.guildStickers, guildId, stickerId, s => s.sticker);
	}

	/** @internal When Discord creates a scheduled event. */
	addScheduledEvent(guildId: string, raw: Record<string, unknown>): ApiScheduledEvent {
		const event = apiScheduledEvent({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(stringValue(raw.channel_id) === undefined ? {} : { channelId: stringValue(raw.channel_id) }),
			...(stringValue(raw.scheduled_start_time) === undefined
				? {}
				: { scheduledStartTime: stringValue(raw.scheduled_start_time) }),
			...(numberValue(raw.entity_type) === undefined ? {} : { entityType: numberValue(raw.entity_type) }),
		});
		(this.world.scheduledEvents ??= []).push({ guildId, event });
		return event;
	}

	/** @internal When Discord deletes a scheduled event. */
	removeScheduledEvent(guildId: string, eventId: string): void {
		this.world.scheduledEvents = removeByGuild(this.world.scheduledEvents, guildId, eventId, e => e.event);
	}

	/** The scheduled events of a guild. */
	scheduledEvents(guildId: string): ApiScheduledEvent[] {
		return listByGuild(this.world.scheduledEvents, guildId, e => e.event);
	}

	/** A single scheduled event by id. */
	scheduledEvent(guildId: string, eventId: string): ApiScheduledEvent | undefined {
		return oneByGuild(this.world.scheduledEvents, guildId, eventId, e => e.event);
	}

	/** @internal When Discord creates a guild template. */
	addGuildTemplate(guildId: string, raw: Record<string, unknown>): ApiGuildTemplate {
		const template = apiGuildTemplate({
			code: stringValue(raw.code),
			name: stringValue(raw.name),
			sourceGuildId: guildId,
			...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		});
		(this.world.guildTemplates ??= []).push({ guildId, template });
		return template;
	}

	/** The templates of a guild. */
	guildTemplates(guildId: string): ApiGuildTemplate[] {
		return listByGuild(this.world.guildTemplates, guildId, t => t.template);
	}

	/** A guild template by code. */
	guildTemplate(code: string): ApiGuildTemplate | undefined {
		return (this.world.guildTemplates ?? []).find(t => t.template.code === code)?.template;
	}

	/** The soundboard sounds of a guild. */
	soundboardSounds(guildId: string): ApiSoundboardSound[] {
		return listByGuild(this.world.soundboardSounds, guildId, s => s.sound);
	}

	/** @internal When Discord creates a stage instance. */
	addStageInstance(raw: Record<string, unknown>): ApiStageInstance {
		const channelId = stringValue(raw.channel_id) ?? mockId();
		const guildId = this.world.channels.find(channel => channel.id === channelId)?.guild_id;
		const stage = apiStageInstance({
			channelId,
			...(guildId === undefined ? {} : { guildId }),
			...(stringValue(raw.topic) === undefined ? {} : { topic: stringValue(raw.topic) }),
			...(numberValue(raw.privacy_level) === undefined ? {} : { privacyLevel: numberValue(raw.privacy_level) }),
		});
		this.world.stageInstances = [
			...(this.world.stageInstances ?? []).filter(entry => entry.channel_id !== channelId),
			stage,
		];
		return stage;
	}

	/** @internal When Discord deletes a stage instance. */
	removeStageInstance(channelId: string): void {
		this.world.stageInstances = (this.world.stageInstances ?? []).filter(entry => entry.channel_id !== channelId);
	}

	/** The live stage instance of a stage channel, if any. */
	stageInstance(channelId: string): ApiStageInstance | undefined {
		return (this.world.stageInstances ?? []).find(entry => entry.channel_id === channelId);
	}

	/** The audit log entries of a guild. */
	auditLogEntries(guildId: string): ApiAuditLogEntry[] {
		return listByGuild(this.world.auditLogEntries, guildId, e => e.entry);
	}

	/** @internal When Discord edits a guild. */
	editGuild(guildId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 100, 'guild name');
		if ('name' in patch) guild.name = stringValue(patch.name) ?? guild.name;
		return { ...guild };
	}

	/** Whether a user is currently banned in a guild. */
	isBanned(guildId: string, userId: string): boolean {
		return this.bansByGuild.get(guildId)?.has(userId) ?? false;
	}

	/** @internal When Discord sets a channel permission overwrite. */
	setChannelOverwrite(channelId: string, overwriteId: string, overwrite: Record<string, unknown>): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		const next: ChannelOverwriteLike = {
			id: overwriteId,
			type: numberValue(overwrite.type) ?? 0,
			allow: stringValue(overwrite.allow) ?? '0',
			deny: stringValue(overwrite.deny) ?? '0',
		};
		channel.permission_overwrites = [
			...channel.permission_overwrites.filter(current => current.id !== overwriteId),
			next,
		];
	}

	/** @internal When Discord removes a channel permission overwrite. */
	removeChannelOverwrite(channelId: string, overwriteId: string): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		channel.permission_overwrites = channel.permission_overwrites.filter(current => current.id !== overwriteId);
	}

	/** @internal For an interaction's first visible reply. */
	addOriginalResponse(token: string, channelId: string, raw: Record<string, unknown>, authorId: string): RawMessage {
		if (this.deletedOriginalTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		this.registerInteractionToken(token, channelId);
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		this.deletedOriginalTokens.delete(token);
		this.messageIdByToken.set(token, view.id);
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal For webhook edits of @original. */
	upsertOriginalResponse(
		token: string,
		raw: Record<string, unknown>,
		authorId: string,
	): RawMessage | Record<string, never> {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		if (this.deletedOriginalTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const messageId = this.messageIdByToken.get(token);
		if (!messageId) return this.addOriginalResponse(token, channelId, raw, authorId);
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal For webhook edits of any interaction message. */
	editWebhookMessage(
		token: string,
		messageId: string,
		raw: Record<string, unknown>,
		authorId: string,
	): RawMessage | Record<string, never> {
		if (messageId === '@original') return this.upsertOriginalResponse(token, raw, authorId);
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		if (!this.rawMessage(channelId, messageId)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal For webhook followups. */
	addFollowup(token: string, raw: Record<string, unknown>, authorId: string): RawMessage | Record<string, never> {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal For webhook deletes of @original. */
	deleteOriginalResponse(token: string): void {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		if (this.deletedOriginalTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		if (channelId && messageId) this.deleteMessage(channelId, messageId);
		this.messageIdByToken.delete(token);
		this.deletedOriginalTokens.add(token);
	}

	isOriginalDeleted(token: string): boolean {
		return this.deletedOriginalTokens.has(token);
	}

	/** @internal For webhook deletes of any interaction message. */
	deleteWebhookMessage(token: string, messageId: string): void {
		if (messageId === '@original') {
			this.deleteOriginalResponse(token);
			return;
		}
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		if (!this.rawMessage(channelId, messageId)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		this.deleteMessage(channelId, messageId);
	}

	protected channelView(channel: ApiChannel): ChannelView {
		const channelMessages = this.world.messages.filter(
			message => message.channelId === channel.id && !isEphemeral(message.message),
		);
		const messages = channelMessages.map(message => this.buildMessageView(message.message));
		const pinnedIds = this.pinnedByChannel.get(channel.id) ?? [];
		const pins = pinnedIds
			.map(id => channelMessages.find(message => message.message.id === id))
			.filter((entry): entry is (typeof channelMessages)[number] => !!entry)
			.map(entry => this.buildMessageView(entry.message));
		return {
			id: channel.id,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			name: channel.name,
			type: channel.type,
			parentId: channel.parent_id,
			...(channel.topic === undefined ? {} : { topic: channel.topic }),
			nsfw: channel.nsfw,
			...(channel.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: channel.rate_limit_per_user }),
			position: channel.position,
			...(channel.thread_metadata === undefined
				? {}
				: {
						archived: channel.thread_metadata.archived,
						locked: channel.thread_metadata.locked,
						threadMetadata: channel.thread_metadata,
					}),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
			messages,
			lastMessage: messages.at(-1),
			pins,
		};
	}

	protected memberView(member: {
		guildId: string;
		member: {
			user: ApiUser;
			roles: string[];
			nick?: string | null;
			communication_disabled_until?: string | null;
		};
	}): GuildMemberView;
	protected memberView(
		guildId: string,
		member: {
			user: ApiUser;
			roles: string[];
			nick?: string | null;
			communication_disabled_until?: string | null;
		},
	): GuildMemberView;
	protected memberView(
		guildOrEntry:
			| string
			| {
					guildId: string;
					member: {
						user: ApiUser;
						roles: string[];
						nick?: string | null;
						communication_disabled_until?: string | null;
					};
			  },
		maybeMember?: {
			user: ApiUser;
			roles: string[];
			nick?: string | null;
			communication_disabled_until?: string | null;
		},
	): GuildMemberView {
		const guildId = typeof guildOrEntry === 'string' ? guildOrEntry : guildOrEntry.guildId;
		const member = typeof guildOrEntry === 'string' ? maybeMember! : guildOrEntry.member;
		return {
			guildId,
			userId: member.user.id,
			roles: [...member.roles],
			nick: member.nick,
			communicationDisabledUntil: member.communication_disabled_until,
		};
	}

	protected buildMessageView(message: ApiMessage): MessageView {
		const { components, componentTypes, textDisplays } = harvestComponents(message.components);
		const reactions = this.reactionViews(message.channel_id, message.id);
		return {
			id: message.id,
			channelId: message.channel_id,
			...(message.guild_id === undefined ? {} : { guildId: message.guild_id }),
			authorId: message.author.id,
			content: message.content,
			embeds: message.embeds.map(normalizeEmbed),
			components: [...message.components],
			isComponentsV2: (message.flags & MESSAGE_FLAG_COMPONENTS_V2) !== 0,
			componentTypes,
			textDisplays,
			attachments: message.attachments.map(attachment => ({
				id: attachment.id,
				filename: attachment.filename,
				contentType: attachment.content_type,
				size: attachment.size,
				url: attachment.url,
			})),
			snapshots: (message.message_snapshots ?? []).map(snapshot => {
				const snapMessage = asRecord(snapshot.message);
				return {
					...(typeof snapMessage.content === 'string' ? { content: snapMessage.content } : {}),
					embeds: arrayValue(snapMessage.embeds).map(normalizeEmbed),
				};
			}),
			interactiveComponents: components,
			component: labelOrCustomId =>
				components.find(component => component.label === labelOrCustomId || component.customId === labelOrCustomId),
			reactions,
			reaction: emoji => reactions.find(entry => entry.emoji === decodeEmoji(emoji)),
			...(message.message_reference === undefined
				? {}
				: {
						reference: {
							...(message.message_reference.message_id === undefined
								? {}
								: { messageId: message.message_reference.message_id }),
							...(message.message_reference.channel_id === undefined
								? {}
								: { channelId: message.message_reference.channel_id }),
							...(message.message_reference.type === undefined ? {} : { type: message.message_reference.type }),
						},
					}),
			...(message.referenced_message === undefined
				? {}
				: {
						referencedMessage: {
							id: message.referenced_message.id,
							channelId: message.referenced_message.channel_id,
							authorId: message.referenced_message.author?.id,
							content: message.referenced_message.content,
						},
					}),
			...(message.poll === undefined
				? {}
				: {
						poll: {
							...(message.poll.question.text === undefined ? {} : { question: message.poll.question.text }),
							answers: message.poll.answers.map(answer => ({
								answerId: answer.answer_id,
								...(answer.poll_media.text === undefined ? {} : { text: answer.poll_media.text }),
							})),
							isFinalized: message.poll.results.is_finalized,
						},
					}),
		};
	}
}
