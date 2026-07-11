import { PermissionFlagsBits } from 'seyfert';
import type { WorldDefaultContext } from './default-context';
import {
	bodyRecord,
	interceptFetchOne,
	memberListLimit,
	messageQuery,
	queryString,
	WEBHOOK_ID_PREFIX,
	webhookChannelOf,
} from './default-context';
import { assertAttachmentRefs } from './message-validation';
import { apiChannel, apiMember, apiMessage, apiUser, apiWebhook } from './payloads';
import { apiError, ErrorCode, type RouteResponder } from './rest';
import { Routes } from './routes';

export function registerCoreWorldRoutes(context: WorldDefaultContext): void {
	const {
		rest,
		world,
		hooks,
		removed,
		key,
		findMember,
		resolveUser,
		guildOfChannel,
		cacheChannel,
		removeCachedChannel,
		requireGuild,
		requireChannel,
		requireMessage,
		requirePerm,
		requireChannelPerm,
		requireThreadPerm,
	} = context;
	rest.intercept(Routes.fetchMembers, (pending, params) => {
		requireGuild(params.guildId);
		const after = queryString(pending.query?.after);
		return (world?.members ?? [])
			.filter(entry => entry.guildId === params.guildId)
			.filter(entry => !removed.has(key(params.guildId, entry.member.user.id)))
			.sort((a, b) => a.member.user.id.localeCompare(b.member.user.id))
			.filter(entry => after === undefined || entry.member.user.id > after)
			.slice(0, memberListLimit(pending.query))
			.map(entry => entry.member);
	});
	rest.intercept(Routes.fetchMember, (_pending, params) => {
		requireGuild(params.guildId);
		if (removed.has(key(params.guildId, params.userId))) {
			return apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
		}
		const entry = findMember(params.guildId, params.userId);
		if (world && !entry) apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
		return entry?.member ?? apiMember({ user: apiUser({ id: params.userId }) });
	});
	interceptFetchOne(
		rest,
		Routes.fetchUser,
		params => world?.users.find(user => user.id === params.userId),
		params => apiUser({ id: params.userId }),
		world ? { code: ErrorCode.UnknownUser, message: 'Unknown User' } : undefined,
	);
	rest.intercept(Routes.fetchRoles, (_pending, params) => {
		requireGuild(params.guildId);
		return world?.roles.filter(entry => entry.guildId === params.guildId).map(entry => entry.role) ?? [];
	});
	rest.intercept(Routes.fetchChannels, (_pending, params) => {
		requireGuild(params.guildId);
		return world?.channels.filter(channel => channel.guild_id === params.guildId) ?? [];
	});
	rest.intercept(Routes.fetchMessages, (pending, params) => {
		requireChannel(params.channelId);
		return hooks.state.channelMessages(params.channelId, messageQuery(pending.query));
	});
	interceptFetchOne(
		rest,
		Routes.fetchMessage,
		params => {
			requireChannel(params.channelId);
			return hooks.state.rawMessage(params.channelId, params.messageId);
		},
		params => apiMessage({ id: params.messageId, channelId: params.channelId }),
		world ? { code: ErrorCode.UnknownMessage, message: 'Unknown Message' } : undefined,
	);
	// A webhook execute (POST /webhooks/:id/:token) and webhook-message ops share the route shape of
	// interaction followups/webhook-messages. Disambiguate by the registry first; a known webhook id with the
	// wrong token is a 404, not a fallback into the `wh-` sendLog encoding.
	const resolveWebhookChannel = (id: string, token: string): string | undefined => {
		const entry = hooks.state.webhookById(id);
		if (entry) {
			if (entry.token !== token) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
			return entry.channel_id;
		}
		const encodedChannelId = webhookChannelOf(id);
		if (!encodedChannelId) return undefined;
		if (token !== 'mock-webhook-token') apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		requireChannel(encodedChannelId);
		return encodedChannelId;
	};
	const requireInteractionWebhook = (applicationId: string, token: string): void => {
		if (!hooks.state.hasInteractionToken(token)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		const expected = hooks.state.applicationIdForToken(token) ?? hooks.applicationId;
		if (applicationId !== expected) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
	};
	rest.intercept(Routes.fetchWebhookMessage, (_pending, params) => {
		const channelId = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (channelId) {
			const message = hooks.state.rawMessage(channelId, params.messageId);
			if (!message) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
			return message;
		}
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		const message = hooks.state.webhookMessage(params.interactionToken, params.messageId);
		if (!message) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		return message;
	});
	// Channel webhooks (sendLog-style). list returns [] so the bot takes the create path; create hands
	// back a webhook whose id encodes the channel AND registers it, so the later execute resolves it.
	rest.intercept(Routes.listChannelWebhooks, (_pending, params) => {
		requireChannel(params.channelId);
		return [];
	});
	rest.intercept(Routes.createWebhook, (pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageWebhooks);
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
	rest.intercept(Routes.fetchWebhook, (_pending, params) => {
		const webhook = hooks.state.webhookById(params.webhookId);
		if (!webhook && world) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		return webhook ?? apiWebhook({ id: params.webhookId });
	});
	rest.intercept(Routes.fetchWebhookToken, (_pending, params) => {
		const webhook = hooks.state.webhookById(params.webhookId);
		if (webhook && webhook.token !== params.webhookToken) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		if (!webhook && world) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		return webhook ?? apiWebhook({ id: params.webhookId, token: params.webhookToken });
	});
	rest.intercept(Routes.editWebhook, (pending, params) => {
		if (world && !hooks.state.webhookById(params.webhookId)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		return hooks.state.editWebhook(params.webhookId, bodyRecord(pending.body)) ?? apiWebhook({ id: params.webhookId });
	});
	rest.intercept(Routes.editWebhookToken, (pending, params) => {
		const webhook = hooks.state.webhookById(params.webhookId);
		if (webhook && webhook.token !== params.webhookToken) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		if (world && !webhook) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		return (
			hooks.state.editWebhook(params.webhookId, bodyRecord(pending.body)) ??
			apiWebhook({ id: params.webhookId, token: params.webhookToken })
		);
	});
	rest.intercept(Routes.deleteWebhook, (_pending, params) => {
		if (world && !hooks.state.webhookById(params.webhookId)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		hooks.state.removeWebhook(params.webhookId);
		return {};
	});
	rest.intercept(Routes.deleteWebhookToken, (_pending, params) => {
		const webhook = hooks.state.webhookById(params.webhookId);
		if (webhook && webhook.token !== params.webhookToken) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		if (world && !webhook) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		hooks.state.removeWebhook(params.webhookId);
		return {};
	});
	rest.intercept(Routes.listGuildWebhooks, (_pending, params) => {
		requireGuild(params.guildId);
		return hooks.state.webhooksForGuild(params.guildId);
	});
	// Gateway reply transport: seyfert posts the interaction callback here. Materialize the original
	// message synchronously (so an in-run fetchResponse sees it) and, when the caller asked for
	// with_response, return the resource so editOrReply(body, true) resolves to a real message.
	rest.intercept(Routes.interactionCallback, (pending, params) => {
		const body = bodyRecord(pending.body) as { type?: number; data?: Record<string, unknown> };
		// F18: reject callback types Discord forbids for the originating interaction. Update callbacks (6/7) are
		// only legal for component (3) and modal-submit (5) interactions, never an application command (2); a
		// modal callback (9) cannot answer a modal submit (5). Skipped when the origin type is unknown (lenient).
		const origin = hooks.state.interactionOrigin(params.token);
		if (origin !== undefined) {
			if ((body.type === 6 || body.type === 7) && origin !== 3 && origin !== 5) {
				apiError(
					400,
					50035,
					'Invalid Form Body: message update callbacks are only valid for component or modal interactions',
				);
			}
			if (body.type === 9 && origin === 5) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: cannot respond to a modal submit with another modal',
				);
			}
		}
		// A token can be acknowledged exactly once. A second callback on it is Discord's 40060, not a duplicate
		// message — the silent double-reply footgun.
		if (hooks.state.isAcknowledged(params.token)) {
			apiError(400, ErrorCode.AlreadyAcknowledged, 'Interaction has already been acknowledged.');
		}
		hooks.state.acknowledgeToken(params.token);
		if (body.type === 6 || body.type === 7) {
			// DeferredMessageUpdate (6) and UpdateMessage (7) both act on the component's source message: point
			// @original there NOW so a later editResponse edits it in place instead of minting a new message.
			const source = hooks.state.componentSource(params.token);
			if (source) {
				hooks.state.registerOriginalResponse(params.token, source.channelId, source.messageId);
				// UpdateMessage (7) carries its content edit: apply it to the source NOW (synchronously) so a later
				// editResponse in the same handler edits the already-updated message instead of overwriting it last.
				if (body.type === 7) {
					assertAttachmentRefs(body.data ?? {}, pending.files);
					hooks.state.editMessage(source.channelId, source.messageId, body.data ?? {});
				}
			}
			return {};
		}
		// Autocomplete result (type 8): Discord caps choices at 25 and each choice name at 1..100 chars.
		if (body.type === 8) {
			const choices = Array.isArray(body.data?.choices) ? (body.data?.choices as unknown[]) : [];
			if (choices.length > 25) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: autocomplete can return at most 25 choices');
			}
			for (const choice of choices) {
				const name = (choice as { name?: unknown }).name;
				if (typeof name !== 'string' || name.length < 1 || [...name].length > 100) {
					apiError(
						400,
						ErrorCode.InvalidFormBody,
						'Invalid Form Body: autocomplete choice name must be between 1 and 100 in length',
					);
				}
			}
		}
		if (body.type !== 4) return {};
		assertAttachmentRefs(body.data ?? {}, pending.files);
		const channelId = hooks.state.channelForToken(params.token);
		if (!channelId) return {};
		const message = hooks.state.addOriginalResponse(params.token, channelId, body.data ?? {}, hooks.botId);
		return pending.query?.with_response ? { resource: { type: body.type, message } } : {};
	});

	rest.intercept(Routes.createDm, pending => {
		const recipientId = String(bodyRecord(pending.body).recipient_id ?? '');
		const user = world?.users.find(entry => entry.id === recipientId);
		// A DM flow (user.write / member.dm) opens a DM channel for the recipient. With a seeded world the recipient
		// must be a known user; guide toward registering it instead of a bare "Unknown User"/"Unknown Channel".
		if (world && !user) {
			apiError(
				404,
				ErrorCode.UnknownUser,
				`Unknown User: no user "${recipientId}" to open a DM with. Register the recipient first — ` +
					`world.registerUser({ id: "${recipientId}" }) (and dispatch as that user) — to enable DM flows.`,
			);
		}
		const recipient = user ?? apiUser({ id: recipientId });
		const channel = hooks.state.registerDm(recipientId, {
			...apiChannel({ guildId: null, type: 1 }),
			recipients: [recipient],
		});
		return { ...channel, recipients: [recipient] };
	});
	rest.intercept(Routes.createChannel, async (pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.ManageChannels);
		const channel = hooks.state.addChannel(params.guildId, { ...bodyRecord(pending.body), guild_id: params.guildId });
		await cacheChannel(channel);
		return channel;
	});
	const threadResponder: RouteResponder = async (pending, params) => {
		requireChannel(params.channelId);
		requireThreadPerm(params.channelId, PermissionFlagsBits.SendMessagesInThreads);
		const thread = hooks.state.addChannel(undefined, {
			...bodyRecord(pending.body),
			parent_id: params.channelId,
			guild_id: guildOfChannel(params.channelId),
			type: bodyRecord(pending.body).type ?? 11,
		});
		await cacheChannel(thread);
		return thread;
	};
	rest.intercept(Routes.createThread, threadResponder);
	rest.intercept(Routes.startThreadFromMessage, (pending, params) => {
		requireMessage(params.channelId, params.messageId);
		return threadResponder(pending, params);
	});
	rest.intercept(Routes.deleteChannel, async (_pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageChannels);
		const existing = world?.channels.find(channel => channel.id === params.channelId);
		const guildId = existing?.guild_id;
		hooks.state.removeChannel(params.channelId);
		await removeCachedChannel(params.channelId, guildId);
		if (guildId) await hooks.cacheRemove('overwrites', params.channelId, guildId);
		return existing ?? apiChannel({ id: params.channelId });
	});

	rest.intercept(Routes.createMessage, (pending, params) => {
		requireChannel(params.channelId);
		assertAttachmentRefs(bodyRecord(pending.body), pending.files);
		const channel = world?.channels.find(entry => entry.id === params.channelId);
		if (channel?.type === 4)
			apiError(400, ErrorCode.CannotExecuteOnChannelType, 'Cannot execute action on this channel type');
		if (channel?.thread_metadata?.archived) apiError(400, ErrorCode.ThreadArchived, 'Thread is archived');
		const view = hooks.state.addMessage(params.channelId, bodyRecord(pending.body));
		return (
			hooks.state.rawMessage(params.channelId, view.id) ?? apiMessage({ id: view.id, channelId: params.channelId })
		);
	});
	rest.intercept(Routes.editMessage, (pending, params) => {
		// F13: editing a non-existent message is a 404, and a message the bot did not author can never be edited
		// (Discord forbids editing others' messages outright) — a 403. Worldless mode stays lenient (synthesize).
		if (world) {
			requireMessage(params.channelId, params.messageId);
			const existing = hooks.state.rawMessage(params.channelId, params.messageId)!;
			if (existing.author.id !== hooks.botId) {
				apiError(403, ErrorCode.CannotEditAnotherUsersMessage, 'Cannot edit a message authored by another user');
			}
		}
		assertAttachmentRefs(bodyRecord(pending.body), pending.files);
		hooks.state.editMessage(params.channelId, params.messageId, bodyRecord(pending.body));
		return (
			hooks.state.rawMessage(params.channelId, params.messageId) ??
			apiMessage({ id: params.messageId, channelId: params.channelId, ...bodyRecord(pending.body) })
		);
	});
	rest.intercept(Routes.deleteMessage, (_pending, params) => {
		// F13: deleting a non-existent message is a 404 (deleting another user's message IS allowed with perms).
		if (world) requireMessage(params.channelId, params.messageId);
		hooks.state.deleteMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.bulkDeleteMessages, (pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageMessages);
		const messages = bodyRecord(pending.body).messages;
		const ids = Array.isArray(messages) ? messages : [];
		if (ids.length < 2 || ids.length > 100) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: messages must contain between 2 and 100 items');
		}
		for (const messageId of ids) hooks.state.deleteMessage(params.channelId, String(messageId));
		return {};
	});
	rest.intercept(Routes.fetchPins, (_pending, params) => {
		requireChannel(params.channelId);
		return {
			has_more: false,
			items: hooks.state.pins(params.channelId).map(message => ({ pinned_at: message.timestamp, message })),
		};
	});
	rest.intercept(Routes.pinMessage, (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageMessages);
		const pins = hooks.state.pins(params.channelId);
		if (pins.length >= 50 && !pins.some(message => message.id === params.messageId)) {
			apiError(400, ErrorCode.MaxPinnedMessages, 'Maximum number of pinned messages reached (50)');
		}
		hooks.state.pinMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.unpinMessage, (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageMessages);
		hooks.state.unpinMessage(params.channelId, params.messageId);
		return {};
	});
	rest.intercept(Routes.fetchArchivedThreads, (_pending, params) => {
		requireChannel(params.channelId);
		return {
			threads: hooks.state.archivedThreads(params.channelId, params.type === 'private' ? 'private' : 'public'),
			members: [],
			has_more: false,
		};
	});
	rest.intercept(Routes.endPoll, (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		const message = hooks.state.finalizePoll(params.channelId, params.messageId);
		if (!message) apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: message has no poll');
		return message;
	});
	rest.intercept(Routes.getPollAnswerVoters, (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		const poll = hooks.state.rawMessage(params.channelId, params.messageId)?.poll;
		if (!poll) apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: message has no poll');
		const answerId = Number(params.answerId);
		if (!poll.answers.some(answer => answer.answer_id === answerId)) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: unknown poll answer');
		}
		return {
			users: hooks.state.pollVoters(params.channelId, params.messageId, answerId).map(userId => resolveUser(userId)),
		};
	});

	rest.intercept(Routes.fetchOriginalResponse, (_pending, params) => {
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		if (!hooks.state.isAcknowledged(params.interactionToken))
			apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		if (hooks.state.isOriginalDeleted(params.interactionToken)) {
			apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		}
		return hooks.state.messageForToken(params.interactionToken) ?? apiMessage();
	});
	rest.intercept(Routes.editOriginalResponse, (pending, params) => {
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		assertAttachmentRefs(bodyRecord(pending.body), pending.files);
		return hooks.state.upsertOriginalResponse(params.interactionToken, bodyRecord(pending.body), hooks.botId);
	});
	rest.intercept(Routes.deleteOriginalResponse, (_pending, params) => {
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		hooks.state.deleteOriginalResponse(params.interactionToken);
		return {};
	});
	rest.intercept(Routes.editWebhookMessage, (pending, params) => {
		const channelId = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (channelId) {
			requireMessage(channelId, params.messageId);
			assertAttachmentRefs(bodyRecord(pending.body), pending.files);
			hooks.state.editMessage(channelId, params.messageId, bodyRecord(pending.body));
			return hooks.state.rawMessage(channelId, params.messageId);
		}
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		assertAttachmentRefs(bodyRecord(pending.body), pending.files);
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
			requireMessage(channelId, params.messageId);
			hooks.state.deleteMessage(channelId, params.messageId);
			return {};
		}
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		hooks.state.deleteWebhookMessage(params.interactionToken, params.messageId);
		return {};
	});
	rest.intercept(Routes.followup, (pending, params) => {
		// Same route shape as a webhook execute. A registered webhook id (or the `wh-` sendLog encoding)
		// resolves to a channel; otherwise it is an interaction followup.
		assertAttachmentRefs(bodyRecord(pending.body), pending.files);
		const webhookChannel = resolveWebhookChannel(params.applicationId, params.interactionToken);
		if (webhookChannel) {
			const view = hooks.state.addMessage(webhookChannel, bodyRecord(pending.body));
			return hooks.state.rawMessage(webhookChannel, view.id) ?? apiMessage();
		}
		requireInteractionWebhook(params.applicationId, params.interactionToken);
		return hooks.state.addFollowup(params.interactionToken, bodyRecord(pending.body), hooks.botId);
	});
}
