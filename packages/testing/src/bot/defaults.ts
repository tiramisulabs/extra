import { type ApiMember, apiChannel, apiGuild, apiMember, apiMessage, apiUser } from './payloads';
import { apiError, type MockApiHandler } from './rest';
import { Routes } from './routes';
import type { WorldState } from './state';
import type { MockWorld } from './world';

interface WorldDefaultHooks {
	emit: (name: 'GUILD_MEMBER_REMOVE' | 'GUILD_MEMBER_UPDATE', payload: Record<string, unknown>) => Promise<void>;
	removeCachedMember: (guildId: string, userId: string) => Promise<void>;
	setCachedMember: (guildId: string, userId: string, member: ApiMember) => Promise<void>;
	simulateGateway: boolean;
	state: WorldState;
	botId: string;
}

function bodyRecord(body: Record<string, unknown> | undefined): Record<string, unknown> {
	return body ?? {};
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

	rest.intercept(
		Routes.fetchGuild,
		(_pending, params) => world?.guilds.find(guild => guild.id === params.guildId) ?? apiGuild({ id: params.guildId }),
	);
	rest.intercept(
		Routes.fetchChannel,
		(_pending, params) =>
			world?.channels.find(channel => channel.id === params.channelId) ?? apiChannel({ id: params.channelId }),
	);
	rest.intercept(Routes.fetchMember, (_pending, params) => {
		if (removed.has(key(params.guildId, params.userId))) {
			return apiError(404, 10007, 'Unknown Member');
		}
		const entry = findMember(params.guildId, params.userId);
		return entry?.member ?? apiMember({ user: apiUser({ id: params.userId }) });
	});
	rest.intercept(
		Routes.fetchUser,
		(_pending, params) => world?.users.find(user => user.id === params.userId) ?? apiUser({ id: params.userId }),
	);
	rest.intercept(
		Routes.fetchRoles,
		(_pending, params) => world?.roles.filter(entry => entry.guildId === params.guildId).map(entry => entry.role) ?? [],
	);
	rest.intercept(
		Routes.fetchChannels,
		(_pending, params) => world?.channels.filter(channel => channel.guild_id === params.guildId) ?? [],
	);
	rest.intercept(Routes.fetchMessages, (_pending, params) => hooks.state.channelMessages(params.channelId));
	rest.intercept(
		Routes.fetchOriginalResponse,
		(_pending, params) => hooks.state.messageForToken(params.interactionToken) ?? apiMessage(),
	);
	rest.intercept(
		Routes.fetchWebhookMessage,
		(_pending, params) => hooks.state.webhookMessage(params.interactionToken, params.messageId) ?? apiMessage(),
	);
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
	rest.intercept(Routes.createThread, (pending, params) =>
		hooks.state.addChannel(undefined, {
			...bodyRecord(pending.body),
			parent_id: params.channelId,
			guild_id: world?.channels.find(channel => channel.id === params.channelId)?.guild_id,
			type: bodyRecord(pending.body).type ?? 11,
		}),
	);
	rest.intercept(Routes.startThreadFromMessage, (pending, params) =>
		hooks.state.addChannel(undefined, {
			...bodyRecord(pending.body),
			parent_id: params.channelId,
			guild_id: world?.channels.find(channel => channel.id === params.channelId)?.guild_id,
			type: bodyRecord(pending.body).type ?? 11,
		}),
	);
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
	rest.intercept(Routes.followup, (pending, params) =>
		hooks.state.addFollowup(params.interactionToken, bodyRecord(pending.body), hooks.botId),
	);

	rest.intercept(Routes.createRole, (pending, params) => hooks.state.addRole(params.guildId, bodyRecord(pending.body)));
	rest.intercept(Routes.ban, async (_pending, params) => {
		await removeMember(params.guildId, params.userId, true);
		return {};
	});
	rest.intercept(Routes.kick, async (_pending, params) => {
		await removeMember(params.guildId, params.userId, false);
		return {};
	});
	rest.intercept(Routes.addRole, async (_pending, params) => {
		const entry = findMember(params.guildId, params.userId);
		if (entry && !entry.member.roles.includes(params.roleId)) {
			entry.member.roles.push(params.roleId);
			hooks.state.setMemberRoles(params.guildId, params.userId, entry.member.roles);
			await emitMemberUpdate(params.guildId, entry.member);
		}
		return {};
	});
	rest.intercept(Routes.removeRole, async (_pending, params) => {
		const entry = findMember(params.guildId, params.userId);
		if (entry) {
			entry.member.roles = entry.member.roles.filter(role => role !== params.roleId);
			hooks.state.setMemberRoles(params.guildId, params.userId, entry.member.roles);
			await emitMemberUpdate(params.guildId, entry.member);
		}
		return {};
	});
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
