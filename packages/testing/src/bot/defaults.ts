import {
	type ApiMember,
	apiAutoModRule,
	apiChannel,
	apiEmoji,
	apiGuild,
	apiGuildTemplate,
	apiInvite,
	apiMember,
	apiMessage,
	apiRole,
	apiScheduledEvent,
	apiStageInstance,
	apiSticker,
	apiThreadMember,
	apiUser,
	apiWebhook,
} from './payloads';
import { PermissionFlagsBits } from 'seyfert/lib/types';
import { computeChannelPermissions } from './permissions';
import { apiError, type MockApiHandler, type RouteMatcher, type RouteResponder } from './rest';
import { Routes } from './routes';
import type { MessageQuery, WorldState } from './state';
import type { MockWorld } from './world';
import type { WorldEmitEvent } from './world-events';

interface WorldDefaultHooks {
	emit: (name: WorldEmitEvent, payload: Record<string, unknown>) => Promise<void>;
	removeCachedMember: (guildId: string, userId: string) => Promise<void>;
	setCachedMember: (guildId: string, userId: string, member: ApiMember) => Promise<void>;
	simulateGateway: boolean;
	state: WorldState;
	botId: string;
}

function bodyRecord(body: Record<string, unknown> | undefined): Record<string, unknown> {
	return body ?? {};
}

function queryString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	return undefined;
}

function messageQuery(query: Record<string, unknown> | undefined): MessageQuery {
	if (!query) return {};
	const limit = queryString(query.limit);
	return {
		...(limit === undefined ? {} : { limit: Number(limit) }),
		...(queryString(query.before) === undefined ? {} : { before: queryString(query.before) }),
		...(queryString(query.after) === undefined ? {} : { after: queryString(query.after) }),
		...(queryString(query.around) === undefined ? {} : { around: queryString(query.around) }),
	};
}

function interceptFetchOne<T>(
	rest: MockApiHandler,
	route: RouteMatcher,
	find: (params: Record<string, string>) => T | undefined,
	fallback: (params: Record<string, string>) => T,
): void {
	rest.intercept(route, (_pending, params) => find(params) ?? fallback(params));
}

/**
 * The uniform create/list/fetch/edit/delete interceptor shape shared by the guild-scoped entities
 * (emoji, automod rule, sticker, scheduled event). Each entity supplies its WorldState mutators/readers
 * plus a synthetic `fallback`; routes are wired only when present, so read-only entities can omit `edit`/`remove`.
 */
interface GuildCrudConfig {
	idParam: string;
	create?: RouteMatcher;
	list?: RouteMatcher;
	fetch?: RouteMatcher;
	edit?: RouteMatcher;
	remove?: RouteMatcher;
	add: (guildId: string, body: Record<string, unknown>) => unknown;
	all: (guildId: string) => unknown;
	one: (guildId: string, id: string) => unknown;
	patch?: (guildId: string, id: string, body: Record<string, unknown>) => unknown;
	drop?: (guildId: string, id: string) => void;
	fallback: (guildId: string, id: string) => unknown;
}

function registerGuildCrud(rest: MockApiHandler, config: GuildCrudConfig): void {
	const { idParam } = config;
	if (config.create) {
		rest.intercept(config.create, (pending, params) => config.add(params.guildId, bodyRecord(pending.body)));
	}
	if (config.list) rest.intercept(config.list, (_pending, params) => config.all(params.guildId));
	if (config.fetch) {
		interceptFetchOne(
			rest,
			config.fetch,
			params => config.one(params.guildId, params[idParam]),
			params => config.fallback(params.guildId, params[idParam]),
		);
	}
	if (config.edit && config.patch) {
		const patch = config.patch;
		rest.intercept(
			config.edit,
			(pending, params) =>
				patch(params.guildId, params[idParam], bodyRecord(pending.body)) ??
				config.fallback(params.guildId, params[idParam]),
		);
	}
	if (config.remove && config.drop) {
		const drop = config.drop;
		rest.intercept(config.remove, (_pending, params) => {
			drop(params.guildId, params[idParam]);
			return {};
		});
	}
}

// Synthesized channel webhooks encode their channel into the id, so an execute
// (POST /webhooks/:id/:token — the same route shape as an interaction followup)
// can recover its target channel without a registry.
const WEBHOOK_ID_PREFIX = 'wh-';
function webhookChannelOf(webhookId: string): string | undefined {
	return webhookId.startsWith(WEBHOOK_ID_PREFIX) ? webhookId.slice(WEBHOOK_ID_PREFIX.length) : undefined;
}

export function registerWorldDefaults(
	rest: MockApiHandler,
	world: MockWorld | undefined,
	hooks: WorldDefaultHooks,
): void {
	const removed = new Set<string>();
	const key = (guildId: string, userId: string) => `${guildId}:${userId}`;
	const findMember = (guildId: string, userId: string) =>
		world?.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId);

	const emitMemberUpdate = async (guildId: string, member: ApiMember) => {
		await hooks.setCachedMember(guildId, member.user.id, member);
		if (hooks.simulateGateway) {
			await hooks.emit('GUILD_MEMBER_UPDATE', { guild_id: guildId, ...member });
		}
	};

	const removeMember = async (guildId: string, userId: string, banned: boolean) => {
		const entry = findMember(guildId, userId);
		removed.add(key(guildId, userId));
		hooks.state.removeMember(guildId, userId, banned);
		await hooks.removeCachedMember(guildId, userId);
		if (hooks.simulateGateway) {
			await hooks.emit('GUILD_MEMBER_REMOVE', {
				guild_id: guildId,
				user: entry?.member.user ?? apiUser({ id: userId }),
			});
		}
	};

	const resolveUser = (id: string) => world?.users.find(user => user.id === id) ?? apiUser({ id });
	const guildOfChannel = (channelId: string) => world?.channels.find(channel => channel.id === channelId)?.guild_id;

	// Permission/hierarchy enforcement is OPT-IN: it only activates once a bot member is seeded
	// (world.registerBotMember). Without one, botGuildPerms returns undefined and every guard early-returns,
	// so bare moderation dispatches stay permissive (the default a test mock wants).
	const guildRolesOf = (guildId: string) => world?.roles.filter(entry => entry.guildId === guildId).map(e => e.role) ?? [];
	const botMemberOf = (guildId: string) =>
		world?.members.find(entry => entry.guildId === guildId && entry.member.user.id === hooks.botId);
	const botGuildPerms = (guildId: string): bigint | undefined => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return undefined;
		return BigInt(
			computeChannelPermissions({
				guild: { id: guild.id, owner_id: guild.owner_id },
				roles: guildRolesOf(guildId).map(role => ({ id: role.id, permissions: role.permissions })),
				member: { userId: hooks.botId, roles: bot.member.roles },
			}),
		);
	};
	const requirePerm = (guildId: string, bit: bigint) => {
		const perms = botGuildPerms(guildId);
		if (perms === undefined) return; // enforcement off (no seeded bot member)
		if (perms & PermissionFlagsBits.Administrator) return;
		if (!(perms & bit)) apiError(403, 50013, 'Missing Permissions');
	};
	const topRole = (roleIds: string[], roles: { id: string; position: number }[]) =>
		Math.max(0, ...roleIds.map(id => roles.find(role => role.id === id)?.position ?? 0));
	const requireHierarchy = (guildId: string, targetUserId: string) => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return; // enforcement off
		if (guild.owner_id === hooks.botId) return; // the bot owns the guild
		if (guild.owner_id === targetUserId) apiError(403, 50013, 'Missing Permissions');
		const target = findMember(guildId, targetUserId);
		if (!target) return;
		const roles = guildRolesOf(guildId);
		if (topRole(target.member.roles, roles) >= topRole(bot.member.roles, roles)) {
			apiError(403, 50013, 'Missing Permissions');
		}
	};
	const requireManageableRole = (guildId: string, roleId: string) => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return; // enforcement off
		if (guild.owner_id === hooks.botId) return;
		const roles = guildRolesOf(guildId);
		if ((roles.find(role => role.id === roleId)?.position ?? 0) >= topRole(bot.member.roles, roles)) {
			apiError(403, 50013, 'Missing Permissions');
		}
	};

	interceptFetchOne(
		rest,
		Routes.fetchGuild,
		params => world?.guilds.find(guild => guild.id === params.guildId),
		params => apiGuild({ id: params.guildId }),
	);
	interceptFetchOne(
		rest,
		Routes.fetchChannel,
		params => world?.channels.find(channel => channel.id === params.channelId),
		params => apiChannel({ id: params.channelId }),
	);
	rest.intercept(Routes.fetchMember, (_pending, params) => {
		if (removed.has(key(params.guildId, params.userId))) {
			return apiError(404, 10007, 'Unknown Member');
		}
		const entry = findMember(params.guildId, params.userId);
		return entry?.member ?? apiMember({ user: apiUser({ id: params.userId }) });
	});
	interceptFetchOne(
		rest,
		Routes.fetchUser,
		params => world?.users.find(user => user.id === params.userId),
		params => apiUser({ id: params.userId }),
	);
	rest.intercept(
		Routes.fetchRoles,
		(_pending, params) => world?.roles.filter(entry => entry.guildId === params.guildId).map(entry => entry.role) ?? [],
	);
	rest.intercept(
		Routes.fetchChannels,
		(_pending, params) => world?.channels.filter(channel => channel.guild_id === params.guildId) ?? [],
	);
	rest.intercept(Routes.fetchMessages, (pending, params) =>
		hooks.state.channelMessages(params.channelId, messageQuery(pending.query)),
	);
	interceptFetchOne(
		rest,
		Routes.fetchMessage,
		params => hooks.state.rawMessage(params.channelId, params.messageId),
		params => apiMessage({ id: params.messageId, channelId: params.channelId }),
	);
	rest.intercept(Routes.fetchOriginalResponse, (_pending, params) => {
		if (!hooks.state.isAcknowledged(params.interactionToken)) apiError(404, 10008, 'Unknown Message');
		return hooks.state.messageForToken(params.interactionToken) ?? apiMessage();
	});
	// A webhook execute (POST /webhooks/:id/:token) and webhook-message ops share the route shape of
	// interaction followups/webhook-messages. Disambiguate by the registry: a known webhook id whose
	// token matches resolves to its channel; otherwise the `wh-` sendLog encoding; otherwise it is an
	// interaction token. Returns undefined for interaction tokens so they fall to the interaction path.
	const resolveWebhookChannel = (id: string, token: string): string | undefined => {
		const entry = hooks.state.webhookById(id);
		if (entry && entry.token === token) return entry.channel_id;
		return webhookChannelOf(id);
	};
	rest.intercept(Routes.fetchWebhookMessage, (_pending, params) => {
		const channelId = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (channelId) return hooks.state.rawMessage(channelId, params.messageId) ?? apiMessage();
		return hooks.state.webhookMessage(params.interactionToken, params.messageId) ?? apiMessage();
	});
	// Channel webhooks (sendLog-style). list returns [] so the bot takes the create path; create hands
	// back a webhook whose id encodes the channel AND registers it, so the later execute resolves it.
	rest.intercept(Routes.listChannelWebhooks, () => []);
	rest.intercept(Routes.createWebhook, (pending, params) => {
		const raw = bodyRecord(pending.body);
		const guildId = guildOfChannel(params.channelId);
		return hooks.state.registerWebhook({
			id: `${WEBHOOK_ID_PREFIX}${params.channelId}`,
			channelId: params.channelId,
			...(guildId === undefined ? {} : { guildId }),
			name: typeof raw.name === 'string' ? raw.name : 'mock-webhook',
			token: 'mock-webhook-token',
			applicationId: hooks.botId,
		});
	});
	rest.intercept(
		Routes.fetchWebhook,
		(_pending, params) => hooks.state.webhookById(params.webhookId) ?? apiWebhook({ id: params.webhookId }),
	);
	rest.intercept(
		Routes.fetchWebhookToken,
		(_pending, params) =>
			hooks.state.webhookById(params.webhookId) ?? apiWebhook({ id: params.webhookId, token: params.webhookToken }),
	);
	rest.intercept(
		Routes.editWebhook,
		(pending, params) =>
			hooks.state.editWebhook(params.webhookId, bodyRecord(pending.body)) ?? apiWebhook({ id: params.webhookId }),
	);
	rest.intercept(
		Routes.editWebhookToken,
		(pending, params) =>
			hooks.state.editWebhook(params.webhookId, bodyRecord(pending.body)) ??
			apiWebhook({ id: params.webhookId, token: params.webhookToken }),
	);
	rest.intercept(Routes.deleteWebhook, (_pending, params) => {
		hooks.state.removeWebhook(params.webhookId);
		return {};
	});
	rest.intercept(Routes.deleteWebhookToken, (_pending, params) => {
		hooks.state.removeWebhook(params.webhookId);
		return {};
	});
	rest.intercept(Routes.listGuildWebhooks, (_pending, params) => hooks.state.webhooksForGuild(params.guildId));
	// Gateway reply transport: seyfert posts the interaction callback here. Materialize the original
	// message synchronously (so an in-run fetchResponse sees it) and, when the caller asked for
	// with_response, return the resource so editOrReply(body, true) resolves to a real message.
	rest.intercept(Routes.interactionCallback, (pending, params) => {
		const body = bodyRecord(pending.body) as { type?: number; data?: Record<string, unknown> };
		hooks.state.acknowledgeToken(params.token);
		if (body.type === 6) {
			// DeferredMessageUpdate: point @original at the component's source message NOW (synchronously), so a
			// later editResponse in the same handler edits it in place instead of minting a new message.
			const source = hooks.state.componentSource(params.token);
			if (source) hooks.state.registerOriginalResponse(params.token, source.channelId, source.messageId);
			return {};
		}
		if (body.type !== 4) return {};
		const channelId = hooks.state.channelForToken(params.token);
		if (!channelId) return {};
		const message = hooks.state.addOriginalResponse(params.token, channelId, body.data ?? {}, hooks.botId);
		return pending.query?.with_response ? { resource: { type: body.type, message } } : {};
	});

	rest.intercept(Routes.createDm, pending => {
		const recipientId = String(bodyRecord(pending.body).recipient_id ?? '');
		const user = world?.users.find(entry => entry.id === recipientId) ?? apiUser({ id: recipientId });
		const channel = hooks.state.registerDm(recipientId, {
			...apiChannel({ guildId: null, type: 1 }),
			recipients: [user],
		});
		return { ...channel, recipients: [user] };
	});
	rest.intercept(Routes.createChannel, (pending, params) =>
		hooks.state.addChannel(params.guildId, { ...bodyRecord(pending.body), guild_id: params.guildId }),
	);
	const threadResponder: RouteResponder = (pending, params) =>
		hooks.state.addChannel(undefined, {
			...bodyRecord(pending.body),
			parent_id: params.channelId,
			guild_id: guildOfChannel(params.channelId),
			type: bodyRecord(pending.body).type ?? 11,
		});
	rest.intercept(Routes.createThread, threadResponder);
	rest.intercept(Routes.startThreadFromMessage, threadResponder);
	rest.intercept(Routes.deleteChannel, (_pending, params) => {
		const existing = world?.channels.find(channel => channel.id === params.channelId);
		hooks.state.removeChannel(params.channelId);
		return existing ?? apiChannel({ id: params.channelId });
	});

	rest.intercept(Routes.createMessage, (pending, params) => {
		const channel = world?.channels.find(entry => entry.id === params.channelId);
		if (channel?.type === 4) apiError(400, 50024, 'Cannot execute action on this channel type');
		if (channel?.thread_metadata?.archived) apiError(400, 50083, 'Thread is archived');
		const view = hooks.state.addMessage(params.channelId, bodyRecord(pending.body));
		return (
			hooks.state.rawMessage(params.channelId, view.id) ?? apiMessage({ id: view.id, channelId: params.channelId })
		);
	});
	rest.intercept(Routes.editMessage, (pending, params) => {
		hooks.state.editMessage(params.channelId, params.messageId, bodyRecord(pending.body));
		return (
			hooks.state.rawMessage(params.channelId, params.messageId) ??
			apiMessage({ id: params.messageId, channelId: params.channelId, ...bodyRecord(pending.body) })
		);
	});
	rest.intercept(Routes.deleteMessage, (_pending, params) => {
		hooks.state.deleteMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.bulkDeleteMessages, (pending, params) => {
		const messages = bodyRecord(pending.body).messages;
		const ids = Array.isArray(messages) ? messages : [];
		if (ids.length < 2 || ids.length > 100) {
			apiError(400, 50035, 'Invalid Form Body: messages must contain between 2 and 100 items');
		}
		for (const messageId of ids) hooks.state.deleteMessage(params.channelId, String(messageId));
		return {};
	});
	rest.intercept(Routes.fetchPins, (_pending, params) => ({
		has_more: false,
		items: hooks.state.pins(params.channelId).map(message => ({ pinned_at: message.timestamp, message })),
	}));
	rest.intercept(Routes.pinMessage, (_pending, params) => {
		const pins = hooks.state.pins(params.channelId);
		if (pins.length >= 50 && !pins.some(message => message.id === params.messageId)) {
			apiError(400, 30003, 'Maximum number of pinned messages reached (50)');
		}
		hooks.state.pinMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.unpinMessage, (_pending, params) => {
		hooks.state.unpinMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.fetchArchivedThreads, (_pending, params) => ({
		threads: hooks.state.archivedThreads(params.channelId, params.type === 'private' ? 'private' : 'public'),
		members: [],
		has_more: false,
	}));
	rest.intercept(
		Routes.endPoll,
		(_pending, params) =>
			hooks.state.finalizePoll(params.channelId, params.messageId) ??
			apiMessage({ id: params.messageId, channelId: params.channelId }),
	);
	rest.intercept(Routes.getPollAnswerVoters, (_pending, params) => ({
		users: hooks.state
			.pollVoters(params.channelId, params.messageId, Number(params.answerId))
			.map(userId => resolveUser(userId)),
	}));

	rest.intercept(Routes.editOriginalResponse, (pending, params) =>
		hooks.state.upsertOriginalResponse(params.interactionToken, bodyRecord(pending.body), hooks.botId),
	);
	rest.intercept(Routes.deleteOriginalResponse, (_pending, params) => {
		hooks.state.deleteOriginalResponse(params.interactionToken);
		return {};
	});
	rest.intercept(Routes.editWebhookMessage, (pending, params) => {
		const channelId = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (channelId) {
			hooks.state.editMessage(channelId, params.messageId, bodyRecord(pending.body));
			return hooks.state.rawMessage(channelId, params.messageId) ?? apiMessage({ id: params.messageId, channelId });
		}
		return hooks.state.editWebhookMessage(
			params.interactionToken,
			params.messageId,
			bodyRecord(pending.body),
			hooks.botId,
		);
	});
	rest.intercept(Routes.deleteWebhookMessage, (_pending, params) => {
		const channelId = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (channelId) {
			hooks.state.deleteMessage(channelId, params.messageId);
			return {};
		}
		hooks.state.deleteWebhookMessage(params.interactionToken, params.messageId);
		return {};
	});
	rest.intercept(Routes.followup, (pending, params) => {
		// Same route shape as a webhook execute. A registered webhook id (or the `wh-` sendLog encoding)
		// resolves to a channel; otherwise it is an interaction followup.
		const webhookChannel = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (webhookChannel) {
			const view = hooks.state.addMessage(webhookChannel, bodyRecord(pending.body));
			return hooks.state.rawMessage(webhookChannel, view.id) ?? apiMessage();
		}
		return hooks.state.addFollowup(params.interactionToken, bodyRecord(pending.body), hooks.botId);
	});

	rest.intercept(Routes.createRole, (pending, params) => hooks.state.addRole(params.guildId, bodyRecord(pending.body)));
	rest.intercept(Routes.editRole, (pending, params) => {
		const updated = hooks.state.editRole(params.guildId, params.roleId, bodyRecord(pending.body));
		return updated ?? apiRole({ id: params.roleId, ...bodyRecord(pending.body) });
	});
	rest.intercept(Routes.deleteRole, (_pending, params) => {
		hooks.state.removeRole(params.guildId, params.roleId);
		return {};
	});
	registerGuildCrud(rest, {
		idParam: 'emojiId',
		create: Routes.createEmoji,
		list: Routes.fetchEmojis,
		fetch: Routes.fetchEmoji,
		edit: Routes.editEmoji,
		remove: Routes.deleteEmoji,
		add: (guildId, body) => hooks.state.addEmoji(guildId, body),
		all: guildId => hooks.state.emojis(guildId),
		one: (guildId, id) => hooks.state.emoji(guildId, id),
		patch: (guildId, id, body) => hooks.state.editEmoji(guildId, id, body),
		drop: (guildId, id) => hooks.state.removeEmoji(guildId, id),
		fallback: (guildId, id) => apiEmoji({ id, guildId }),
	});
	rest.intercept(Routes.createInvite, (pending, params) =>
		hooks.state.addInvite(params.channelId, guildOfChannel(params.channelId), bodyRecord(pending.body)),
	);
	rest.intercept(Routes.listChannelInvites, (_pending, params) => hooks.state.channelInvites(params.channelId));
	rest.intercept(Routes.listGuildInvites, (_pending, params) => hooks.state.guildInvites(params.guildId));
	rest.intercept(
		Routes.fetchInvite,
		(_pending, params) => hooks.state.invite(params.code) ?? apiInvite({ code: params.code }),
	);
	rest.intercept(
		Routes.deleteInvite,
		(_pending, params) => hooks.state.removeInvite(params.code) ?? apiInvite({ code: params.code }),
	);
	rest.intercept(Routes.bulkBan, async (pending, params) => {
		requirePerm(params.guildId, PermissionFlagsBits.BanMembers);
		const rawIds = bodyRecord(pending.body).user_ids;
		const userIds = (Array.isArray(rawIds) ? rawIds : []).map(String);
		for (const userId of userIds) requireHierarchy(params.guildId, userId);
		for (const userId of userIds) await removeMember(params.guildId, userId, true);
		return { banned_users: userIds, failed_users: [] };
	});
	registerGuildCrud(rest, {
		idParam: 'ruleId',
		create: Routes.createAutoModRule,
		list: Routes.fetchAutoModRules,
		fetch: Routes.fetchAutoModRule,
		edit: Routes.editAutoModRule,
		remove: Routes.deleteAutoModRule,
		add: (guildId, body) => hooks.state.addAutoModRule(guildId, body),
		all: guildId => hooks.state.autoModRules(guildId),
		one: (guildId, id) => hooks.state.autoModRule(guildId, id),
		patch: (guildId, id, body) => hooks.state.editAutoModRule(guildId, id, body),
		drop: (guildId, id) => hooks.state.removeAutoModRule(guildId, id),
		fallback: (guildId, id) => apiAutoModRule({ id, guildId }),
	});
	const resolveThreadUser = (userId: string) => (userId === '@me' ? hooks.botId : userId);
	rest.intercept(Routes.addThreadMember, (_pending, params) => {
		hooks.state.addThreadMember(params.channelId, resolveThreadUser(params.userId));
		return {};
	});
	rest.intercept(Routes.removeThreadMember, (_pending, params) => {
		hooks.state.removeThreadMember(params.channelId, resolveThreadUser(params.userId));
		return {};
	});
	rest.intercept(Routes.listThreadMembers, (_pending, params) =>
		hooks.state.threadMembers(params.channelId).map(userId => apiThreadMember({ threadId: params.channelId, userId })),
	);
	rest.intercept(Routes.fetchThreadMember, (_pending, params) =>
		apiThreadMember({ threadId: params.channelId, userId: resolveThreadUser(params.userId) }),
	);
	rest.intercept(Routes.fetchActiveThreads, (_pending, params) => ({
		threads: hooks.state.activeThreads(params.guildId),
		members: [],
		has_more: false,
	}));
	registerGuildCrud(rest, {
		idParam: 'stickerId',
		create: Routes.createSticker,
		list: Routes.fetchStickers,
		fetch: Routes.fetchSticker,
		edit: Routes.editSticker,
		remove: Routes.deleteSticker,
		add: (guildId, body) => hooks.state.addSticker(guildId, body),
		all: guildId => hooks.state.stickers(guildId),
		one: (guildId, id) => hooks.state.sticker(guildId, id),
		patch: (guildId, id, body) => hooks.state.editSticker(guildId, id, body),
		drop: (guildId, id) => hooks.state.removeSticker(guildId, id),
		fallback: (guildId, id) => apiSticker({ id, guildId }),
	});
	registerGuildCrud(rest, {
		idParam: 'eventId',
		create: Routes.createScheduledEvent,
		list: Routes.fetchScheduledEvents,
		fetch: Routes.fetchScheduledEvent,
		remove: Routes.deleteScheduledEvent,
		add: (guildId, body) => hooks.state.addScheduledEvent(guildId, body),
		all: guildId => hooks.state.scheduledEvents(guildId),
		one: (guildId, id) => hooks.state.scheduledEvent(guildId, id),
		drop: (guildId, id) => hooks.state.removeScheduledEvent(guildId, id),
		fallback: (guildId, id) => apiScheduledEvent({ id, guildId }),
	});
	rest.intercept(Routes.listGuildTemplates, (_pending, params) => hooks.state.guildTemplates(params.guildId));
	rest.intercept(Routes.createGuildTemplate, (pending, params) =>
		hooks.state.addGuildTemplate(params.guildId, bodyRecord(pending.body)),
	);
	rest.intercept(
		Routes.fetchGuildTemplate,
		(_pending, params) => hooks.state.guildTemplate(params.code) ?? apiGuildTemplate({ code: params.code }),
	);
	rest.intercept(Routes.listGuildSoundboardSounds, (_pending, params) => ({
		items: hooks.state.soundboardSounds(params.guildId),
	}));
	rest.intercept(Routes.listDefaultSoundboardSounds, () => []);
	rest.intercept(Routes.createStageInstance, pending => hooks.state.addStageInstance(bodyRecord(pending.body)));
	interceptFetchOne(
		rest,
		Routes.fetchStageInstance,
		params => hooks.state.stageInstance(params.channelId),
		params => apiStageInstance({ channelId: params.channelId }),
	);
	rest.intercept(Routes.deleteStageInstance, (_pending, params) => {
		hooks.state.removeStageInstance(params.channelId);
		return {};
	});
	rest.intercept(Routes.fetchAuditLogs, (_pending, params) => ({
		audit_log_entries: hooks.state.auditLogEntries(params.guildId),
		users: [],
		auto_moderation_rules: [],
		guild_scheduled_events: [],
		integrations: [],
		threads: [],
		webhooks: [],
	}));
	rest.intercept(Routes.editGuild, (pending, params) => {
		const updated = hooks.state.editGuild(params.guildId, bodyRecord(pending.body));
		return updated ?? { ...apiGuild({ id: params.guildId }), ...bodyRecord(pending.body) };
	});
	rest.intercept(Routes.fetchBan, (_pending, params) => {
		if (!hooks.state.isBanned(params.guildId, params.userId)) {
			return apiError(404, 10026, 'Unknown Ban');
		}
		return { user: resolveUser(params.userId) };
	});
	rest.intercept(Routes.ban, async (_pending, params) => {
		requirePerm(params.guildId, PermissionFlagsBits.BanMembers);
		requireHierarchy(params.guildId, params.userId);
		await removeMember(params.guildId, params.userId, true);
		return {};
	});
	rest.intercept(Routes.kick, async (_pending, params) => {
		requirePerm(params.guildId, PermissionFlagsBits.KickMembers);
		requireHierarchy(params.guildId, params.userId);
		await removeMember(params.guildId, params.userId, false);
		return {};
	});
	rest.intercept(Routes.unban, (_pending, params) => {
		hooks.state.unban(params.guildId, params.userId);
		return {};
	});
	rest.intercept(Routes.fetchBans, (_pending, params) =>
		hooks.state.bans(params.guildId).map(userId => ({
			user: resolveUser(userId),
		})),
	);
	rest.intercept(Routes.editChannel, (pending, params) => {
		const updated = hooks.state.editChannel(params.channelId, bodyRecord(pending.body));
		return updated ?? { ...apiChannel({ id: params.channelId }), ...bodyRecord(pending.body) };
	});
	rest.intercept(Routes.editChannelPermissions, (pending, params) => {
		hooks.state.setChannelOverwrite(params.channelId, params.overwriteId, bodyRecord(pending.body));
		return {};
	});
	rest.intercept(Routes.deleteChannelPermission, (_pending, params) => {
		hooks.state.removeChannelOverwrite(params.channelId, params.overwriteId);
		return {};
	});
	rest.intercept(Routes.triggerTyping, () => ({}));

	const decodeEmoji = (emoji: string): string => {
		if (!emoji.includes('%')) return emoji;
		try {
			return decodeURIComponent(emoji);
		} catch {
			return emoji;
		}
	};
	// Reaction routes carry the emoji as `name` (unicode) or `name:id` (custom), per seyfert's encodeEmoji.
	const emojiPayload = (emoji: string): { name: string; id: string | null } => {
		const decoded = decodeEmoji(emoji);
		const colon = decoded.indexOf(':');
		return colon === -1 ? { name: decoded, id: null } : { name: decoded.slice(0, colon), id: decoded.slice(colon + 1) };
	};
	const reactionEventBase = (channelId: string, messageId: string) => {
		const guildId = world?.channels.find(channel => channel.id === channelId)?.guild_id;
		return {
			channel_id: channelId,
			message_id: messageId,
			...(guildId === undefined ? {} : { guild_id: guildId }),
		};
	};
	const emitReaction = async (
		name: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE',
		channelId: string,
		messageId: string,
		emoji: string,
		userId: string,
	) => {
		if (!hooks.simulateGateway) return;
		await hooks.emit(name, {
			...reactionEventBase(channelId, messageId),
			user_id: userId,
			emoji: emojiPayload(emoji),
		});
	};

	rest.intercept(Routes.addReaction, async (_pending, params) => {
		if (!hooks.state.rawMessage(params.channelId, params.messageId)) apiError(404, 10008, 'Unknown Message');
		hooks.state.addReaction(params.channelId, params.messageId, params.emoji, hooks.botId);
		await emitReaction('MESSAGE_REACTION_ADD', params.channelId, params.messageId, params.emoji, hooks.botId);
		return {};
	});
	rest.intercept(Routes.removeOwnReaction, async (_pending, params) => {
		hooks.state.removeReaction(params.channelId, params.messageId, params.emoji, hooks.botId);
		await emitReaction('MESSAGE_REACTION_REMOVE', params.channelId, params.messageId, params.emoji, hooks.botId);
		return {};
	});
	rest.intercept(Routes.removeUserReaction, async (_pending, params) => {
		// `@me` collides with the own-reaction route shape; route it to the bot user for parity.
		const userId = params.userId === '@me' ? hooks.botId : params.userId;
		hooks.state.removeReaction(params.channelId, params.messageId, params.emoji, userId);
		await emitReaction('MESSAGE_REACTION_REMOVE', params.channelId, params.messageId, params.emoji, userId);
		return {};
	});
	rest.intercept(Routes.removeEmojiReactions, async (_pending, params) => {
		hooks.state.removeEmojiReactions(params.channelId, params.messageId, params.emoji);
		if (hooks.simulateGateway) {
			await hooks.emit('MESSAGE_REACTION_REMOVE_EMOJI', {
				...reactionEventBase(params.channelId, params.messageId),
				emoji: emojiPayload(params.emoji),
			});
		}
		return {};
	});
	rest.intercept(Routes.removeAllReactions, async (_pending, params) => {
		hooks.state.removeAllReactions(params.channelId, params.messageId);
		if (hooks.simulateGateway) {
			await hooks.emit('MESSAGE_REACTION_REMOVE_ALL', reactionEventBase(params.channelId, params.messageId));
		}
		return {};
	});
	rest.intercept(Routes.listReactions, (_pending, params) =>
		hooks.state.reactionUsers(params.channelId, params.messageId, params.emoji).map(userId => resolveUser(userId)),
	);
	const interceptRoleMutation = (
		route: RouteMatcher,
		mutate: (member: ApiMember, roleId: string) => string[] | undefined,
	) =>
		rest.intercept(route, async (_pending, params) => {
			requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
			requireManageableRole(params.guildId, params.roleId);
			const entry = findMember(params.guildId, params.userId);
			const roles = entry && mutate(entry.member, params.roleId);
			if (entry && roles) {
				entry.member.roles = roles;
				hooks.state.setMemberRoles(params.guildId, params.userId, roles);
				await emitMemberUpdate(params.guildId, entry.member);
			}
			return {};
		});
	interceptRoleMutation(Routes.addRole, (member, roleId) =>
		member.roles.includes(roleId) ? undefined : [...member.roles, roleId],
	);
	interceptRoleMutation(Routes.removeRole, (member, roleId) => member.roles.filter(role => role !== roleId));
	rest.intercept(Routes.editMember, async (pending, params) => {
		const entry = findMember(params.guildId, params.userId);
		if (!entry) return apiMember({ user: apiUser({ id: params.userId }) });
		const body = bodyRecord(pending.body) as {
			nick?: string | null;
			roles?: string[];
			communication_disabled_until?: string | null;
		};
		if ('nick' in body) requirePerm(params.guildId, PermissionFlagsBits.ManageNicknames);
		if (body.roles) requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
		if ('communication_disabled_until' in body) requirePerm(params.guildId, PermissionFlagsBits.ModerateMembers);
		requireHierarchy(params.guildId, params.userId);
		hooks.state.patchMember(params.guildId, params.userId, body);
		if ('nick' in body) entry.member.nick = body.nick ?? null;
		if (body.roles) entry.member.roles = [...body.roles];
		if ('communication_disabled_until' in body)
			entry.member.communication_disabled_until = body.communication_disabled_until;
		await emitMemberUpdate(params.guildId, entry.member);
		return entry.member;
	});
}
