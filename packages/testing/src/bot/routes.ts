import type { RouteMatcher } from './rest';

export const Routes = {
	ban: { method: 'PUT', route: '/guilds/:guildId/bans/:userId' },
	unban: { method: 'DELETE', route: '/guilds/:guildId/bans/:userId' },
	kick: { method: 'DELETE', route: '/guilds/:guildId/members/:userId' },
	editMember: { method: 'PATCH', route: '/guilds/:guildId/members/:userId' },
	addRole: { method: 'PUT', route: '/guilds/:guildId/members/:userId/roles/:roleId' },
	removeRole: { method: 'DELETE', route: '/guilds/:guildId/members/:userId/roles/:roleId' },
	createMessage: { method: 'POST', route: '/channels/:channelId/messages' },
	editMessage: { method: 'PATCH', route: '/channels/:channelId/messages/:messageId' },
	deleteMessage: { method: 'DELETE', route: '/channels/:channelId/messages/:messageId' },
	bulkDeleteMessages: { method: 'POST', route: '/channels/:channelId/messages/bulk-delete' },
	createDm: { method: 'POST', route: '/users/@me/channels' },
	createRole: { method: 'POST', route: '/guilds/:guildId/roles' },
	createChannel: { method: 'POST', route: '/guilds/:guildId/channels' },
	deleteChannel: { method: 'DELETE', route: '/channels/:channelId' },
	createThread: { method: 'POST', route: '/channels/:channelId/threads' },
	addReaction: { method: 'PUT', route: '/channels/:channelId/messages/:messageId/reactions/:emoji/@me' },
	fetchChannel: { method: 'GET', route: '/channels/:channelId' },
	fetchMember: { method: 'GET', route: '/guilds/:guildId/members/:userId' },
	fetchGuild: { method: 'GET', route: '/guilds/:guildId' },
	fetchUser: { method: 'GET', route: '/users/:userId' },
	fetchOriginalResponse: { method: 'GET', route: '/webhooks/:applicationId/:interactionToken/messages/@original' },
	editOriginalResponse: { method: 'PATCH', route: '/webhooks/:applicationId/:interactionToken/messages/@original' },
	deleteOriginalResponse: { method: 'DELETE', route: '/webhooks/:applicationId/:interactionToken/messages/@original' },
	fetchWebhookMessage: { method: 'GET', route: '/webhooks/:applicationId/:interactionToken/messages/:messageId' },
	editWebhookMessage: { method: 'PATCH', route: '/webhooks/:applicationId/:interactionToken/messages/:messageId' },
	deleteWebhookMessage: { method: 'DELETE', route: '/webhooks/:applicationId/:interactionToken/messages/:messageId' },
	followup: { method: 'POST', route: '/webhooks/:applicationId/:interactionToken' },
	interactionCallback: { method: 'POST', route: '/interactions/:id/:token/callback' },
	listChannelWebhooks: { method: 'GET', route: '/channels/:channelId/webhooks' },
	createWebhook: { method: 'POST', route: '/channels/:channelId/webhooks' },
	fetchMessages: { method: 'GET', route: '/channels/:channelId/messages' },
	fetchRoles: { method: 'GET', route: '/guilds/:guildId/roles' },
	fetchChannels: { method: 'GET', route: '/guilds/:guildId/channels' },
	fetchBans: { method: 'GET', route: '/guilds/:guildId/bans' },
	fetchPins: { method: 'GET', route: '/channels/:channelId/pins' },
	editChannel: { method: 'PATCH', route: '/channels/:channelId' },
	createInvite: { method: 'POST', route: '/channels/:channelId/invites' },
	pinMessage: { method: 'PUT', route: '/channels/:channelId/pins/:messageId' },
	unpinMessage: { method: 'DELETE', route: '/channels/:channelId/pins/:messageId' },
	startThreadFromMessage: { method: 'POST', route: '/channels/:channelId/messages/:messageId/threads' },
	crosspostMessage: { method: 'POST', route: '/channels/:channelId/messages/:messageId/crosspost' },
	triggerTyping: { method: 'POST', route: '/channels/:channelId/typing' },
} as const satisfies Record<string, RouteMatcher>;

export const ORIGINAL_RESPONSE_ROUTE = /\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/;
export const WEBHOOK_MESSAGE_ROUTE = /\/webhooks\/[^/]+\/[^/]+\/messages\/[^/]+$/;
export const FOLLOWUP_ROUTE = /\/webhooks\/[^/]+\/[^/]+$/;
export const CHANNEL_MESSAGE_POST = /\/channels\/[^/]+\/messages$/;
export const WEBHOOK_EXECUTE_POST = /\/webhooks\/wh-[^/]+\/[^/]+$/;
