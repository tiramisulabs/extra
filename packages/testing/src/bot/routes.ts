import type * as API from 'seyfert';
import type { RouteMatcher } from './rest';

function defineRoute<TBody, TResponse>() {
	return <const TRoute extends string>(
		matcher: Pick<RouteMatcher<TRoute>, 'method' | 'route'>,
	): RouteMatcher<TRoute, TBody, TResponse> => matcher;
}

export const Routes = {
	ban: defineRoute<API.RESTPutAPIGuildBanJSONBody | undefined, API.RESTPutAPIGuildBanResult>()({
		method: 'PUT',
		route: '/guilds/:guildId/bans/:userId',
	}),
	unban: defineRoute<never, API.RESTDeleteAPIGuildBanResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/bans/:userId',
	}),
	kick: defineRoute<never, API.RESTDeleteAPIGuildMemberResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/members/:userId',
	}),
	editMember: defineRoute<API.RESTPatchAPIGuildMemberJSONBody, API.RESTPatchAPIGuildMemberResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId/members/:userId',
	}),
	addRole: defineRoute<never, API.RESTPutAPIGuildMemberRoleResult>()({
		method: 'PUT',
		route: '/guilds/:guildId/members/:userId/roles/:roleId',
	}),
	removeRole: defineRoute<never, API.RESTDeleteAPIGuildMemberRoleResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/members/:userId/roles/:roleId',
	}),
	createMessage: defineRoute<API.RESTPostAPIChannelMessageJSONBody, API.RESTPostAPIChannelMessageResult>()({
		method: 'POST',
		route: '/channels/:channelId/messages',
	}),
	editMessage: defineRoute<API.RESTPatchAPIChannelMessageJSONBody, API.RESTPatchAPIChannelMessageResult>()({
		method: 'PATCH',
		route: '/channels/:channelId/messages/:messageId',
	}),
	deleteMessage: defineRoute<never, API.RESTDeleteAPIChannelMessageResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/:messageId',
	}),
	bulkDeleteMessages: defineRoute<
		API.RESTPostAPIChannelMessagesBulkDeleteJSONBody,
		API.RESTPostAPIChannelMessagesBulkDeleteResult
	>()({ method: 'POST', route: '/channels/:channelId/messages/bulk-delete' }),
	createDm: defineRoute<API.RESTPostAPICurrentUserCreateDMChannelJSONBody, API.APIDMChannel>()({
		method: 'POST',
		route: '/users/@me/channels',
	}),
	createRole: defineRoute<API.RESTPostAPIGuildRoleJSONBody, API.RESTPostAPIGuildRoleResult>()({
		method: 'POST',
		route: '/guilds/:guildId/roles',
	}),
	editRole: defineRoute<API.RESTPatchAPIGuildRoleJSONBody, API.RESTPatchAPIGuildRoleResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId/roles/:roleId',
	}),
	deleteRole: defineRoute<never, API.RESTDeleteAPIGuildRoleResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/roles/:roleId',
	}),
	editGuild: defineRoute<API.RESTPatchAPIGuildJSONBody, API.RESTPatchAPIGuildResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId',
	}),
	fetchBan: defineRoute<never, API.RESTGetAPIGuildBanResult>()({
		method: 'GET',
		route: '/guilds/:guildId/bans/:userId',
	}),
	editChannelPermissions: defineRoute<API.RESTPutAPIChannelPermissionJSONBody, API.RESTPutAPIChannelPermissionResult>()(
		{ method: 'PUT', route: '/channels/:channelId/permissions/:overwriteId' },
	),
	deleteChannelPermission: defineRoute<never, API.RESTDeleteAPIChannelPermissionResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/permissions/:overwriteId',
	}),
	createChannel: defineRoute<API.RESTPostAPIGuildChannelJSONBody, API.RESTPostAPIGuildChannelResult>()({
		method: 'POST',
		route: '/guilds/:guildId/channels',
	}),
	deleteChannel: defineRoute<never, API.RESTDeleteAPIChannelResult>()({
		method: 'DELETE',
		route: '/channels/:channelId',
	}),
	createThread: defineRoute<
		API.RESTPostAPIChannelThreadsJSONBody | API.RESTPostAPIGuildForumThreadsJSONBody,
		API.RESTPostAPIChannelThreadsResult
	>()({ method: 'POST', route: '/channels/:channelId/threads' }),
	addReaction: defineRoute<never, API.RESTPutAPIChannelMessageReactionResult>()({
		method: 'PUT',
		route: '/channels/:channelId/messages/:messageId/reactions/:emoji/@me',
	}),
	removeOwnReaction: defineRoute<never, API.RESTDeleteAPIChannelMessageOwnReactionResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/:messageId/reactions/:emoji/@me',
	}),
	removeUserReaction: defineRoute<never, API.RESTDeleteAPIChannelMessageUserReactionResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/:messageId/reactions/:emoji/:userId',
	}),
	removeAllReactions: defineRoute<never, API.RESTDeleteAPIChannelAllMessageReactionsResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/:messageId/reactions',
	}),
	removeEmojiReactions: defineRoute<never, API.RESTDeleteAPIChannelMessageReactionResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/:messageId/reactions/:emoji',
	}),
	listReactions: defineRoute<never, API.RESTGetAPIChannelMessageReactionUsersResult>()({
		method: 'GET',
		route: '/channels/:channelId/messages/:messageId/reactions/:emoji',
	}),
	fetchChannel: defineRoute<never, API.RESTGetAPIChannelResult>()({
		method: 'GET',
		route: '/channels/:channelId',
	}),
	fetchMembers: defineRoute<never, API.RESTGetAPIGuildMembersResult>()({
		method: 'GET',
		route: '/guilds/:guildId/members',
	}),
	fetchMember: defineRoute<never, API.RESTGetAPIGuildMemberResult>()({
		method: 'GET',
		route: '/guilds/:guildId/members/:userId',
	}),
	fetchGuild: defineRoute<never, API.RESTGetAPIGuildResult>()({
		method: 'GET',
		route: '/guilds/:guildId',
	}),
	fetchUser: defineRoute<never, API.RESTGetAPIUserResult>()({ method: 'GET', route: '/users/:userId' }),
	fetchOriginalResponse: defineRoute<never, API.RESTGetAPIInteractionOriginalResponseResult>()({
		method: 'GET',
		route: '/webhooks/:applicationId/:interactionToken/messages/@original',
	}),
	editOriginalResponse: defineRoute<
		API.RESTPatchAPIInteractionOriginalResponseJSONBody,
		API.RESTPatchAPIInteractionOriginalResponseResult
	>()({ method: 'PATCH', route: '/webhooks/:applicationId/:interactionToken/messages/@original' }),
	deleteOriginalResponse: defineRoute<never, API.RESTDeleteAPIInteractionOriginalResponseResult>()({
		method: 'DELETE',
		route: '/webhooks/:applicationId/:interactionToken/messages/@original',
	}),
	fetchWebhookMessage: defineRoute<never, API.RESTGetAPIWebhookWithTokenMessageResult>()({
		method: 'GET',
		route: '/webhooks/:applicationId/:interactionToken/messages/:messageId',
	}),
	editWebhookMessage: defineRoute<
		API.RESTPatchAPIWebhookWithTokenMessageJSONBody,
		API.RESTPatchAPIWebhookWithTokenMessageResult
	>()({ method: 'PATCH', route: '/webhooks/:applicationId/:interactionToken/messages/:messageId' }),
	deleteWebhookMessage: defineRoute<never, API.RESTDeleteAPIWebhookWithTokenMessageResult>()({
		method: 'DELETE',
		route: '/webhooks/:applicationId/:interactionToken/messages/:messageId',
	}),
	followup: defineRoute<API.RESTPostAPIInteractionFollowupJSONBody, API.RESTPostAPIInteractionFollowupResult>()({
		method: 'POST',
		route: '/webhooks/:applicationId/:interactionToken',
	}),
	interactionCallback: defineRoute<
		API.RESTPostAPIInteractionCallbackJSONBody,
		API.RESTPostAPIInteractionCallbackResult | undefined
	>()({ method: 'POST', route: '/interactions/:id/:token/callback' }),
	listChannelWebhooks: defineRoute<never, API.RESTGetAPIGuildWebhooksResult>()({
		method: 'GET',
		route: '/channels/:channelId/webhooks',
	}),
	createWebhook: defineRoute<API.RESTPostAPIChannelWebhookJSONBody, API.RESTPostAPIChannelWebhookResult>()({
		method: 'POST',
		route: '/channels/:channelId/webhooks',
	}),
	fetchMessages: defineRoute<never, API.RESTGetAPIChannelMessagesResult>()({
		method: 'GET',
		route: '/channels/:channelId/messages',
	}),
	fetchMessage: defineRoute<never, API.RESTGetAPIChannelMessageResult>()({
		method: 'GET',
		route: '/channels/:channelId/messages/:messageId',
	}),
	fetchRoles: defineRoute<never, API.RESTGetAPIGuildRolesResult>()({
		method: 'GET',
		route: '/guilds/:guildId/roles',
	}),
	fetchChannels: defineRoute<never, API.RESTGetAPIGuildChannelsResult>()({
		method: 'GET',
		route: '/guilds/:guildId/channels',
	}),
	fetchBans: defineRoute<never, API.RESTGetAPIGuildBansResult>()({
		method: 'GET',
		route: '/guilds/:guildId/bans',
	}),
	fetchPins: defineRoute<never, API.RESTGetAPIChannelMessagesPinsResult>()({
		method: 'GET',
		route: '/channels/:channelId/messages/pins',
	}),
	editChannel: defineRoute<API.RESTPatchAPIChannelJSONBody, API.RESTPatchAPIChannelResult>()({
		method: 'PATCH',
		route: '/channels/:channelId',
	}),
	createInvite: defineRoute<API.RESTPostAPIChannelInviteJSONBody, API.RESTPostAPIChannelInviteResult>()({
		method: 'POST',
		route: '/channels/:channelId/invites',
	}),
	pinMessage: defineRoute<never, API.RESTPutAPIChannelMessagesPinResult>()({
		method: 'PUT',
		route: '/channels/:channelId/messages/pins/:messageId',
	}),
	unpinMessage: defineRoute<never, API.RESTDeleteAPIChannelMessagesPinResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/messages/pins/:messageId',
	}),
	fetchArchivedThreads: defineRoute<
		never,
		API.RESTGetAPIChannelThreadsArchivedPublicResult | API.RESTGetAPIChannelThreadsArchivedPrivateResult
	>()({ method: 'GET', route: '/channels/:channelId/threads/archived/:type' }),
	startThreadFromMessage: defineRoute<
		API.RESTPostAPIChannelMessagesThreadsJSONBody,
		API.RESTPostAPIChannelMessagesThreadsResult
	>()({ method: 'POST', route: '/channels/:channelId/messages/:messageId/threads' }),
	crosspostMessage: defineRoute<never, API.RESTPostAPIChannelMessageCrosspostResult>()({
		method: 'POST',
		route: '/channels/:channelId/messages/:messageId/crosspost',
	}),
	triggerTyping: defineRoute<never, API.RESTPostAPIChannelTypingResult>()({
		method: 'POST',
		route: '/channels/:channelId/typing',
	}),
	createEmoji: defineRoute<API.RESTPostAPIGuildEmojiJSONBody, API.RESTPostAPIGuildEmojiResult>()({
		method: 'POST',
		route: '/guilds/:guildId/emojis',
	}),
	fetchEmojis: defineRoute<never, API.RESTGetAPIGuildEmojisResult>()({
		method: 'GET',
		route: '/guilds/:guildId/emojis',
	}),
	fetchEmoji: defineRoute<never, API.RESTGetAPIGuildEmojiResult>()({
		method: 'GET',
		route: '/guilds/:guildId/emojis/:emojiId',
	}),
	editEmoji: defineRoute<API.RESTPatchAPIGuildEmojiJSONBody, API.RESTPatchAPIGuildEmojiResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId/emojis/:emojiId',
	}),
	deleteEmoji: defineRoute<never, API.RESTDeleteAPIGuildEmojiResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/emojis/:emojiId',
	}),
	listChannelInvites: defineRoute<never, API.RESTGetAPIChannelInvitesResult>()({
		method: 'GET',
		route: '/channels/:channelId/invites',
	}),
	listGuildInvites: defineRoute<never, API.RESTGetAPIGuildInvitesResult>()({
		method: 'GET',
		route: '/guilds/:guildId/invites',
	}),
	fetchInvite: defineRoute<never, API.RESTGetAPIInviteResult>()({
		method: 'GET',
		route: '/invites/:code',
	}),
	deleteInvite: defineRoute<never, API.RESTDeleteAPIInviteResult>()({
		method: 'DELETE',
		route: '/invites/:code',
	}),
	bulkBan: defineRoute<API.RESTPostAPIGuildBulkBanJSONBody, API.RESTPostAPIGuildBulkBanResult>()({
		method: 'POST',
		route: '/guilds/:guildId/bulk-bans',
	}),
	fetchAutoModRules: defineRoute<never, API.RESTGetAPIAutoModerationRulesResult>()({
		method: 'GET',
		route: '/guilds/:guildId/auto-moderation/rules',
	}),
	createAutoModRule: defineRoute<API.RESTPostAPIAutoModerationRuleJSONBody, API.RESTPostAPIAutoModerationRuleResult>()({
		method: 'POST',
		route: '/guilds/:guildId/auto-moderation/rules',
	}),
	fetchAutoModRule: defineRoute<never, API.RESTGetAPIAutoModerationRuleResult>()({
		method: 'GET',
		route: '/guilds/:guildId/auto-moderation/rules/:ruleId',
	}),
	editAutoModRule: defineRoute<API.RESTPatchAPIAutoModerationRuleJSONBody, API.RESTPatchAPIAutoModerationRuleResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId/auto-moderation/rules/:ruleId',
	}),
	deleteAutoModRule: defineRoute<never, API.RESTDeleteAPIAutoModerationRuleResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/auto-moderation/rules/:ruleId',
	}),
	addThreadMember: defineRoute<never, API.RESTPutAPIChannelThreadMembersResult>()({
		method: 'PUT',
		route: '/channels/:channelId/thread-members/:userId',
	}),
	removeThreadMember: defineRoute<never, API.RESTDeleteAPIChannelThreadMembersResult>()({
		method: 'DELETE',
		route: '/channels/:channelId/thread-members/:userId',
	}),
	listThreadMembers: defineRoute<never, API.RESTGetAPIChannelThreadMembersResult>()({
		method: 'GET',
		route: '/channels/:channelId/thread-members',
	}),
	fetchThreadMember: defineRoute<never, API.RESTGetAPIChannelThreadMemberResult>()({
		method: 'GET',
		route: '/channels/:channelId/thread-members/:userId',
	}),
	fetchActiveThreads: defineRoute<never, API.RESTGetAPIGuildThreadsResult>()({
		method: 'GET',
		route: '/guilds/:guildId/threads/active',
	}),
	endPoll: defineRoute<never, API.RESTPostAPIPollExpireResult>()({
		method: 'POST',
		route: '/channels/:channelId/polls/:messageId/expire',
	}),
	getPollAnswerVoters: defineRoute<never, API.RESTGetAPIPollAnswerVotersResult>()({
		method: 'GET',
		route: '/channels/:channelId/polls/:messageId/answers/:answerId',
	}),
	createSticker: defineRoute<
		Omit<API.RESTPostAPIGuildStickerFormDataBody, 'file'>,
		API.RESTPostAPIGuildStickerResult
	>()({ method: 'POST', route: '/guilds/:guildId/stickers' }),
	fetchStickers: defineRoute<never, API.RESTGetAPIGuildStickersResult>()({
		method: 'GET',
		route: '/guilds/:guildId/stickers',
	}),
	fetchSticker: defineRoute<never, API.RESTGetAPIGuildStickerResult>()({
		method: 'GET',
		route: '/guilds/:guildId/stickers/:stickerId',
	}),
	editSticker: defineRoute<API.RESTPatchAPIGuildStickerJSONBody, API.RESTPatchAPIGuildStickerResult>()({
		method: 'PATCH',
		route: '/guilds/:guildId/stickers/:stickerId',
	}),
	deleteSticker: defineRoute<never, API.RESTDeleteAPIGuildStickerResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/stickers/:stickerId',
	}),
	fetchScheduledEvents: defineRoute<never, API.RESTGetAPIGuildScheduledEventsResult>()({
		method: 'GET',
		route: '/guilds/:guildId/scheduled-events',
	}),
	createScheduledEvent: defineRoute<
		API.RESTPostAPIGuildScheduledEventJSONBody,
		API.RESTPostAPIGuildScheduledEventResult
	>()({ method: 'POST', route: '/guilds/:guildId/scheduled-events' }),
	fetchScheduledEvent: defineRoute<never, API.RESTGetAPIGuildScheduledEventResult>()({
		method: 'GET',
		route: '/guilds/:guildId/scheduled-events/:eventId',
	}),
	deleteScheduledEvent: defineRoute<never, API.RESTDeleteAPIGuildScheduledEventResult>()({
		method: 'DELETE',
		route: '/guilds/:guildId/scheduled-events/:eventId',
	}),
	fetchGuildTemplate: defineRoute<never, API.RESTGetAPITemplateResult>()({
		method: 'GET',
		route: '/guilds/templates/:code',
	}),
	listGuildTemplates: defineRoute<never, API.RESTGetAPIGuildTemplatesResult>()({
		method: 'GET',
		route: '/guilds/:guildId/templates',
	}),
	createGuildTemplate: defineRoute<API.RESTPostAPIGuildTemplatesJSONBody, API.RESTPostAPIGuildTemplatesResult>()({
		method: 'POST',
		route: '/guilds/:guildId/templates',
	}),
	listGuildSoundboardSounds: defineRoute<never, API.RESTGetAPIGuildSoundboardSoundsResult>()({
		method: 'GET',
		route: '/guilds/:guildId/soundboard-sounds',
	}),
	listDefaultSoundboardSounds: defineRoute<never, API.RESTGetAPISoundboardDefaultSoundsResult>()({
		method: 'GET',
		route: '/soundboard-default-sounds',
	}),
	createStageInstance: defineRoute<API.RESTPostAPIStageInstanceJSONBody, API.RESTPostAPIStageInstanceResult>()({
		method: 'POST',
		route: '/stage-instances',
	}),
	fetchStageInstance: defineRoute<never, API.RESTGetAPIStageInstanceResult>()({
		method: 'GET',
		route: '/stage-instances/:channelId',
	}),
	deleteStageInstance: defineRoute<never, API.RESTDeleteAPIStageInstanceResult>()({
		method: 'DELETE',
		route: '/stage-instances/:channelId',
	}),
	fetchAuditLogs: defineRoute<never, API.RESTGetAPIAuditLogResult>()({
		method: 'GET',
		route: '/guilds/:guildId/audit-logs',
	}),
	fetchWebhook: defineRoute<never, API.RESTGetAPIWebhookResult>()({
		method: 'GET',
		route: '/webhooks/:webhookId',
	}),
	fetchWebhookToken: defineRoute<never, API.RESTGetAPIWebhookWithTokenResult>()({
		method: 'GET',
		route: '/webhooks/:webhookId/:webhookToken',
	}),
	editWebhook: defineRoute<API.RESTPatchAPIWebhookJSONBody, API.RESTPatchAPIWebhookResult>()({
		method: 'PATCH',
		route: '/webhooks/:webhookId',
	}),
	editWebhookToken: defineRoute<API.RESTPatchAPIWebhookWithTokenJSONBody, API.RESTPatchAPIWebhookWithTokenResult>()({
		method: 'PATCH',
		route: '/webhooks/:webhookId/:webhookToken',
	}),
	deleteWebhook: defineRoute<never, API.RESTDeleteAPIWebhookResult>()({
		method: 'DELETE',
		route: '/webhooks/:webhookId',
	}),
	deleteWebhookToken: defineRoute<never, API.RESTDeleteAPIWebhookWithTokenResult>()({
		method: 'DELETE',
		route: '/webhooks/:webhookId/:webhookToken',
	}),
	listGuildWebhooks: defineRoute<never, API.RESTGetAPIGuildWebhooksResult>()({
		method: 'GET',
		route: '/guilds/:guildId/webhooks',
	}),
} as const satisfies Record<string, RouteMatcher>;

/**
 * Coverage checklist for every {@link Routes} entry. `handled` = registerWorldDefaults installs a
 * stateful interceptor; `synthetic` = intentionally left to the fail-loud synthetic fallback. The
 * `satisfies Record<keyof typeof Routes, …>` makes adding a route without classifying it a compile
 * error — closing the "added a route, forgot the handler" gap the maintenance map tracked by hand.
 */
export const ROUTE_COVERAGE = {
	ban: 'handled',
	unban: 'handled',
	kick: 'handled',
	editMember: 'handled',
	addRole: 'handled',
	removeRole: 'handled',
	createMessage: 'handled',
	editMessage: 'handled',
	deleteMessage: 'handled',
	bulkDeleteMessages: 'handled',
	createDm: 'handled',
	createRole: 'handled',
	editRole: 'handled',
	deleteRole: 'handled',
	editGuild: 'handled',
	fetchBan: 'handled',
	editChannelPermissions: 'handled',
	deleteChannelPermission: 'handled',
	createChannel: 'handled',
	deleteChannel: 'handled',
	createThread: 'handled',
	addReaction: 'handled',
	removeOwnReaction: 'handled',
	removeUserReaction: 'handled',
	removeAllReactions: 'handled',
	removeEmojiReactions: 'handled',
	listReactions: 'handled',
	fetchChannel: 'handled',
	fetchMembers: 'handled',
	fetchMember: 'handled',
	fetchGuild: 'handled',
	fetchUser: 'handled',
	fetchOriginalResponse: 'handled',
	editOriginalResponse: 'handled',
	deleteOriginalResponse: 'handled',
	fetchWebhookMessage: 'handled',
	editWebhookMessage: 'handled',
	deleteWebhookMessage: 'handled',
	followup: 'handled',
	interactionCallback: 'handled',
	listChannelWebhooks: 'handled',
	createWebhook: 'handled',
	fetchMessages: 'handled',
	fetchMessage: 'handled',
	fetchRoles: 'handled',
	fetchChannels: 'handled',
	fetchBans: 'handled',
	fetchPins: 'handled',
	editChannel: 'handled',
	createInvite: 'handled',
	pinMessage: 'handled',
	unpinMessage: 'handled',
	fetchArchivedThreads: 'handled',
	startThreadFromMessage: 'handled',
	crosspostMessage: 'synthetic',
	triggerTyping: 'handled',
	createEmoji: 'handled',
	fetchEmojis: 'handled',
	fetchEmoji: 'handled',
	editEmoji: 'handled',
	deleteEmoji: 'handled',
	listChannelInvites: 'handled',
	listGuildInvites: 'handled',
	fetchInvite: 'handled',
	deleteInvite: 'handled',
	bulkBan: 'handled',
	fetchAutoModRules: 'handled',
	createAutoModRule: 'handled',
	fetchAutoModRule: 'handled',
	editAutoModRule: 'handled',
	deleteAutoModRule: 'handled',
	addThreadMember: 'handled',
	removeThreadMember: 'handled',
	listThreadMembers: 'handled',
	fetchThreadMember: 'handled',
	fetchActiveThreads: 'handled',
	endPoll: 'handled',
	getPollAnswerVoters: 'handled',
	createSticker: 'handled',
	fetchStickers: 'handled',
	fetchSticker: 'handled',
	editSticker: 'handled',
	deleteSticker: 'handled',
	fetchScheduledEvents: 'handled',
	createScheduledEvent: 'handled',
	fetchScheduledEvent: 'handled',
	deleteScheduledEvent: 'handled',
	fetchGuildTemplate: 'handled',
	listGuildTemplates: 'handled',
	createGuildTemplate: 'handled',
	listGuildSoundboardSounds: 'handled',
	listDefaultSoundboardSounds: 'handled',
	createStageInstance: 'handled',
	fetchStageInstance: 'handled',
	deleteStageInstance: 'handled',
	fetchAuditLogs: 'handled',
	fetchWebhook: 'handled',
	fetchWebhookToken: 'handled',
	editWebhook: 'handled',
	editWebhookToken: 'handled',
	deleteWebhook: 'handled',
	deleteWebhookToken: 'handled',
	listGuildWebhooks: 'handled',
} as const satisfies Record<keyof typeof Routes, 'handled' | 'synthetic'>;

export const WEBHOOK_MESSAGE_ROUTE = /\/webhooks\/[^/]+\/[^/]+\/messages\/[^/]+$/;
export const FOLLOWUP_ROUTE = /\/webhooks\/[^/]+\/[^/]+$/;
export const CHANNEL_MESSAGE_POST = /\/channels\/[^/]+\/messages$/;
export const WEBHOOK_EXECUTE_POST = /\/webhooks\/wh-[^/]+\/[^/]+$/;
