import { type ApiMember, apiChannel, apiGuild, apiMember, apiMessage, apiRole, apiUser } from './payloads';
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
		params => apiMessage({ id: params.messageId, channelId: params.channelId }) as unknown as Record<string, unknown>,
	);
	rest.intercept(
		Routes.fetchOriginalResponse,
		(_pending, params) => hooks.state.messageForToken(params.interactionToken) ?? apiMessage(),
	);
	rest.intercept(
		Routes.fetchWebhookMessage,
		(_pending, params) => hooks.state.webhookMessage(params.interactionToken, params.messageId) ?? apiMessage(),
	);
	// Channel webhooks (sendLog-style). list returns [] so the bot takes the create path;
	// create hands back a webhook whose id encodes the channel, so the later execute resolves it.
	rest.intercept(Routes.listChannelWebhooks, () => []);
	rest.intercept(Routes.createWebhook, (pending, params) => {
		const raw = bodyRecord(pending.body);
		return {
			id: `${WEBHOOK_ID_PREFIX}${params.channelId}`,
			type: 1,
			channel_id: params.channelId,
			name: typeof raw.name === 'string' ? raw.name : 'mock-webhook',
			token: 'mock-webhook-token',
			application_id: hooks.botId,
		};
	});
	// Gateway reply transport: seyfert posts the interaction callback here. Materialize the original
	// message synchronously (so an in-run fetchResponse sees it) and, when the caller asked for
	// with_response, return the resource so editOrReply(body, true) resolves to a real message.
	rest.intercept(Routes.interactionCallback, (pending, params) => {
		const body = bodyRecord(pending.body) as { type?: number; data?: Record<string, unknown> };
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
			guild_id: world?.channels.find(channel => channel.id === params.channelId)?.guild_id,
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
		if (Array.isArray(messages)) {
			for (const messageId of messages) hooks.state.deleteMessage(params.channelId, String(messageId));
		}
		return {};
	});
	rest.intercept(Routes.fetchPins, (_pending, params) => ({
		has_more: false,
		items: hooks.state.pins(params.channelId).map(message => ({ pinned_at: message.timestamp, message })),
	}));
	rest.intercept(Routes.pinMessage, (_pending, params) => {
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
			.map(userId => world?.users.find(user => user.id === userId) ?? apiUser({ id: userId })),
	}));

	rest.intercept(Routes.editOriginalResponse, (pending, params) =>
		hooks.state.upsertOriginalResponse(params.interactionToken, bodyRecord(pending.body), hooks.botId),
	);
	rest.intercept(Routes.deleteOriginalResponse, (_pending, params) => {
		hooks.state.deleteOriginalResponse(params.interactionToken);
		return {};
	});
	rest.intercept(Routes.editWebhookMessage, (pending, params) =>
		hooks.state.editWebhookMessage(params.interactionToken, params.messageId, bodyRecord(pending.body), hooks.botId),
	);
	rest.intercept(Routes.deleteWebhookMessage, (_pending, params) => {
		hooks.state.deleteWebhookMessage(params.interactionToken, params.messageId);
		return {};
	});
	rest.intercept(Routes.followup, (pending, params) => {
		// Same route shape as a webhook execute. A webhook-encoded id means it's a channel
		// webhook send (sendLog); otherwise it's an interaction followup.
		const webhookChannel = webhookChannelOf(params.applicationId);
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
	rest.intercept(Routes.editGuild, (pending, params) => {
		const updated = hooks.state.editGuild(params.guildId, bodyRecord(pending.body));
		return updated ?? { ...apiGuild({ id: params.guildId }), ...bodyRecord(pending.body) };
	});
	rest.intercept(Routes.fetchBan, (_pending, params) => {
		if (!hooks.state.isBanned(params.guildId, params.userId)) {
			return apiError(404, 10026, 'Unknown Ban');
		}
		return { user: world?.users.find(user => user.id === params.userId) ?? apiUser({ id: params.userId }) };
	});
	rest.intercept(Routes.ban, async (_pending, params) => {
		await removeMember(params.guildId, params.userId, true);
		return {};
	});
	rest.intercept(Routes.kick, async (_pending, params) => {
		await removeMember(params.guildId, params.userId, false);
		return {};
	});
	rest.intercept(Routes.unban, (_pending, params) => {
		hooks.state.unban(params.guildId, params.userId);
		return {};
	});
	rest.intercept(Routes.fetchBans, (_pending, params) =>
		hooks.state.bans(params.guildId).map(userId => ({
			user: world?.users.find(user => user.id === userId) ?? apiUser({ id: userId }),
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
		hooks.state
			.reactionUsers(params.channelId, params.messageId, params.emoji)
			.map(userId => world?.users.find(user => user.id === userId) ?? apiUser({ id: userId })),
	);
	const interceptRoleMutation = (
		route: RouteMatcher,
		mutate: (member: ApiMember, roleId: string) => string[] | undefined,
	) =>
		rest.intercept(route, async (_pending, params) => {
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
		hooks.state.patchMember(params.guildId, params.userId, body);
		if ('nick' in body) entry.member.nick = body.nick ?? null;
		if (body.roles) entry.member.roles = [...body.roles];
		if ('communication_disabled_until' in body)
			entry.member.communication_disabled_until = body.communication_disabled_until;
		await emitMemberUpdate(params.guildId, entry.member);
		return entry.member;
	});
}
