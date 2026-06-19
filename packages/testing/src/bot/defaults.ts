import { PermissionFlagsBits } from 'seyfert/lib/types';
import { emojiPayload } from './emoji';
import { assertAttachmentRefs } from './message-validation';
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
	messageReactionAddEvent,
} from './payloads';
import { computeChannelPermissions } from './permissions';
import { apiError, ErrorCode, MockApiError, type MockApiHandler, type RouteMatcher, type RouteResponder } from './rest';
import { ROUTE_COVERAGE, Routes } from './routes';
import type { MessageQuery, WorldState } from './state';
import type { MockWorld } from './world';
import type { WorldEmitEvent } from './world-events';

type CacheResourceName = 'channels' | 'roles' | 'stageInstances' | 'emojis' | 'stickers' | 'overwrites' | 'bans';

interface WorldDefaultHooks {
	emit: (name: WorldEmitEvent, payload: Record<string, unknown>) => Promise<void>;
	removeCachedMember: (guildId: string, userId: string) => Promise<void>;
	setCachedMember: (guildId: string, userId: string, member: ApiMember) => Promise<void>;
	/** Keep a seyfert cache resource in sync with a REST mutation, so a later cache read converges with the world. */
	cacheSet: (resource: CacheResourceName, id: string, guildId: string, data: unknown) => Promise<void>;
	cacheRemove: (resource: CacheResourceName, id: string, guildId: string) => Promise<void>;
	simulateGateway: boolean;
	state: WorldState;
	botId: string;
	applicationId: string;
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
	unknown?: { code: number; message: string },
): void {
	rest.intercept(route, (_pending, params) => {
		const found = find(params);
		if (found !== undefined) return found;
		if (unknown) apiError(404, unknown.code, unknown.message);
		return rest.markSynthetic(fallback(params));
	});
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
	/** Guild-existence guard (world-gated requireGuild); runs before every create/edit/delete. */
	parentGuard?: (guildId: string) => void;
	guard?: (guildId: string) => void;
	/** When set (world mode), an edit/delete of a missing entity is this 404 code instead of a fabrication. */
	unknownCode?: number;
	unknownMessage?: string;
}

function registerGuildCrud(rest: MockApiHandler, config: GuildCrudConfig): void {
	const { idParam } = config;
	if (config.create) {
		rest.intercept(config.create, async (pending, params) => {
			config.guard?.(params.guildId);
			return await config.add(params.guildId, bodyRecord(pending.body));
		});
	}
	if (config.list)
		rest.intercept(config.list, (_pending, params) => {
			config.parentGuard?.(params.guildId);
			return config.all(params.guildId);
		});
	if (config.fetch) {
		rest.intercept(config.fetch, (_pending, params) => {
			config.parentGuard?.(params.guildId);
			const found = config.one(params.guildId, params[idParam]);
			if (found !== undefined) return found;
			if (config.unknownCode !== undefined) {
				apiError(404, config.unknownCode, config.unknownMessage ?? 'Unknown');
			}
			return rest.markSynthetic(config.fallback(params.guildId, params[idParam]));
		});
	}
	if (config.edit && config.patch) {
		const patch = config.patch;
		rest.intercept(config.edit, async (pending, params) => {
			config.guard?.(params.guildId);
			const patched = await patch(params.guildId, params[idParam], bodyRecord(pending.body));
			if (patched !== undefined) return patched;
			if (config.unknownCode !== undefined) apiError(404, config.unknownCode, config.unknownMessage ?? 'Unknown');
			return rest.markSynthetic(config.fallback(params.guildId, params[idParam]));
		});
	}
	if (config.remove && config.drop) {
		const drop = config.drop;
		rest.intercept(config.remove, async (_pending, params) => {
			config.guard?.(params.guildId);
			if (config.unknownCode !== undefined && config.one(params.guildId, params[idParam]) === undefined) {
				apiError(404, config.unknownCode, config.unknownMessage ?? 'Unknown');
			}
			await drop(params.guildId, params[idParam]);
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
	const channelPermissionTarget = (channelId: string) =>
		world?.channels.find(channel => channel.id === channelId)?.parent_id ?? channelId;
	const cacheChannel = async (channel: Record<string, unknown>) => {
		const id = typeof channel.id === 'string' ? channel.id : undefined;
		const guildId = typeof channel.guild_id === 'string' ? channel.guild_id : undefined;
		if (id && guildId) await hooks.cacheSet('channels', id, guildId, channel);
	};
	const removeCachedChannel = async (channelId: string, guildId: string | undefined) => {
		if (guildId) await hooks.cacheRemove('channels', channelId, guildId);
	};
	const cacheRole = async (guildId: string, role: { id: string }) => {
		await hooks.cacheSet('roles', role.id, guildId, role);
	};
	const removeCachedRole = async (guildId: string, roleId: string) => {
		await hooks.cacheRemove('roles', roleId, guildId);
	};
	const cacheStage = async (stage: { channel_id?: unknown; guild_id?: unknown }) => {
		const channelId = typeof stage.channel_id === 'string' ? stage.channel_id : undefined;
		const guildId = typeof stage.guild_id === 'string' ? stage.guild_id : undefined;
		if (channelId && guildId) {
			await hooks.cacheSet('stageInstances', channelId, guildId, stage);
		}
	};
	const removeCachedStage = async (channelId: string, guildId: string | undefined) => {
		if (guildId) await hooks.cacheRemove('stageInstances', channelId, guildId);
	};
	// Mirror a channel's overwrite list into seyfert's separate `overwrites` cache resource after a REST edit.
	const syncOverwriteCache = async (channelId: string) => {
		const channel = world?.channels.find(entry => entry.id === channelId);
		if (!channel?.guild_id) return;
		if (channel.permission_overwrites.length)
			await hooks.cacheSet('overwrites', channelId, channel.guild_id, channel.permission_overwrites);
		else await hooks.cacheRemove('overwrites', channelId, channel.guild_id);
	};

	// F15: when a world is seeded, a guild-scoped op against an unknown (or stringified undefined/null) guild id
	// is a 404 Unknown Guild — Discord never performs it. Worldless mode stays lenient (synthesize), so unit
	// tests that don't model a world are unaffected.
	const requireGuild = (guildId: string) => {
		if (!world) return;
		if (guildId === 'undefined' || guildId === 'null' || !world.guilds.some(guild => guild.id === guildId)) {
			apiError(404, ErrorCode.UnknownGuild, 'Unknown Guild');
		}
	};

	// F14: a channel-scoped write against an unknown channel id is a 404 Unknown Channel when a world is seeded.
	// Created channels/threads and DMs are pushed into world.channels, so they pass. Worldless mode stays lenient.
	const requireChannel = (channelId: string) => {
		if (!world) return;
		if (
			channelId === 'undefined' ||
			channelId === 'null' ||
			!world.channels.some(channel => channel.id === channelId)
		) {
			apiError(404, ErrorCode.UnknownChannel, 'Unknown Channel');
		}
	};
	const requireMessage = (channelId: string, messageId: string) => {
		requireChannel(channelId);
		if (!hooks.state.rawMessage(channelId, messageId)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
	};

	// Permission/hierarchy enforcement is OPT-IN: it only activates once a bot member is seeded
	// (world.registerBotMember). Without one, botGuildPerms returns undefined and every guard early-returns,
	// so bare moderation dispatches stay permissive (the default a test mock wants).
	const guildRolesOf = (guildId: string) =>
		world?.roles.filter(entry => entry.guildId === guildId).map(e => e.role) ?? [];
	const botMemberOf = (guildId: string) =>
		world?.members.find(entry => entry.guildId === guildId && entry.member.user.id === hooks.botId);
	// channelId, when given, folds that channel's allow/deny overwrites into the computation so a permission
	// denied (or granted) at the channel level is honored — not just the guild-wide base.
	const botGuildPerms = (guildId: string, channelId?: string): bigint | undefined => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return undefined;
		const channel = channelId ? world.channels.find(entry => entry.id === channelId) : undefined;
		return BigInt(
			computeChannelPermissions({
				guild: { id: guild.id, owner_id: guild.owner_id },
				roles: guildRolesOf(guildId).map(role => ({ id: role.id, permissions: role.permissions })),
				member: { userId: hooks.botId, roles: bot.member.roles },
				...(channel ? { channel: { permission_overwrites: channel.permission_overwrites } } : {}),
			}),
		);
	};
	const requirePerm = (guildId: string, bit: bigint, channelId?: string) => {
		const perms = botGuildPerms(guildId, channelId);
		if (perms === undefined) return; // enforcement off (no seeded bot member)
		if (perms & PermissionFlagsBits.Administrator) return;
		if (!(perms & bit)) apiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
	};
	// Channel-scoped permission guard: resolves the channel's guild and folds its overwrites into the check.
	const requireChannelPerm = (channelId: string, bit: bigint) =>
		requirePerm(guildOfChannel(channelId) ?? '', bit, channelId);
	const requireThreadPerm = (channelId: string, bit: bigint) => {
		const target = channelPermissionTarget(channelId);
		requirePerm(guildOfChannel(target) ?? '', bit, target);
	};
	const topRole = (roleIds: string[], roles: { id: string; position: number }[]) =>
		Math.max(0, ...roleIds.map(id => roles.find(role => role.id === id)?.position ?? 0));
	const requireHierarchy = (guildId: string, targetUserId: string) => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return; // enforcement off
		if (guild.owner_id === hooks.botId) return; // the bot owns the guild
		if (guild.owner_id === targetUserId) apiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
		const target = findMember(guildId, targetUserId);
		if (!target) return;
		const roles = guildRolesOf(guildId);
		if (topRole(target.member.roles, roles) >= topRole(bot.member.roles, roles)) {
			apiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
		}
	};
	const requireManageableRole = (guildId: string, roleId: string) => {
		const bot = botMemberOf(guildId);
		const guild = world?.guilds.find(entry => entry.id === guildId);
		if (!world || !bot || !guild) return; // enforcement off
		if (guild.owner_id === hooks.botId) return;
		const roles = guildRolesOf(guildId);
		if ((roles.find(role => role.id === roleId)?.position ?? 0) >= topRole(bot.member.roles, roles)) {
			apiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
		}
	};

	interceptFetchOne(
		rest,
		Routes.fetchGuild,
		params => world?.guilds.find(guild => guild.id === params.guildId),
		params => apiGuild({ id: params.guildId }),
		world ? { code: ErrorCode.UnknownGuild, message: 'Unknown Guild' } : undefined,
	);
	interceptFetchOne(
		rest,
		Routes.fetchChannel,
		params => world?.channels.find(channel => channel.id === params.channelId),
		params => apiChannel({ id: params.channelId }),
		world ? { code: ErrorCode.UnknownChannel, message: 'Unknown Channel' } : undefined,
	);
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
		if (world && !user) apiError(404, ErrorCode.UnknownUser, 'Unknown User');
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
			users: hooks.state
				.pollVoters(params.channelId, params.messageId, answerId)
				.map(userId => resolveUser(userId)),
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

	rest.intercept(Routes.createRole, async (pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
		const role = hooks.state.addRole(params.guildId, bodyRecord(pending.body));
		await cacheRole(params.guildId, role);
		return role;
	});
	rest.intercept(Routes.editRole, async (pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
		if (params.roleId === params.guildId) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: the @everyone role cannot be edited');
		}
		if (world && !guildRolesOf(params.guildId).some(role => role.id === params.roleId)) {
			apiError(404, ErrorCode.UnknownRole, 'Unknown Role');
		}
		requireManageableRole(params.guildId, params.roleId);
		const updated = hooks.state.editRole(params.guildId, params.roleId, bodyRecord(pending.body));
		if (updated) await cacheRole(params.guildId, updated);
		return updated ?? apiRole({ id: params.roleId, ...bodyRecord(pending.body) });
	});
	rest.intercept(Routes.deleteRole, async (_pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
		if (params.roleId === params.guildId) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: the @everyone role cannot be deleted');
		}
		if (world && !guildRolesOf(params.guildId).some(role => role.id === params.roleId)) {
			apiError(404, ErrorCode.UnknownRole, 'Unknown Role');
		}
		requireManageableRole(params.guildId, params.roleId);
		hooks.state.removeRole(params.guildId, params.roleId);
		await removeCachedRole(params.guildId, params.roleId);
		return {};
	});
	registerGuildCrud(rest, {
		idParam: 'emojiId',
		create: Routes.createEmoji,
		list: Routes.fetchEmojis,
		fetch: Routes.fetchEmoji,
		edit: Routes.editEmoji,
		remove: Routes.deleteEmoji,
		add: async (guildId, body) => {
			const entity = hooks.state.addEmoji(guildId, body);
			await hooks.cacheSet('emojis', entity.id, guildId, entity);
			return entity;
		},
		all: guildId => hooks.state.emojis(guildId),
		one: (guildId, id) => hooks.state.emoji(guildId, id),
		patch: async (guildId, id, body) => {
			const entity = hooks.state.editEmoji(guildId, id, body);
			if (entity) await hooks.cacheSet('emojis', id, guildId, entity);
			return entity;
		},
		drop: async (guildId, id) => {
			hooks.state.removeEmoji(guildId, id);
			await hooks.cacheRemove('emojis', id, guildId);
		},
		fallback: (guildId, id) => apiEmoji({ id, guildId }),
		parentGuard: requireGuild,
		guard: (guildId: string) => {
			requireGuild(guildId);
			requirePerm(guildId, PermissionFlagsBits.ManageGuildExpressions);
		},
		unknownCode: world ? ErrorCode.UnknownEmoji : undefined,
		unknownMessage: 'Unknown Emoji',
	});
	rest.intercept(Routes.createInvite, (pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.CreateInstantInvite);
		return hooks.state.addInvite(params.channelId, guildOfChannel(params.channelId), bodyRecord(pending.body));
	});
	rest.intercept(Routes.listChannelInvites, (_pending, params) => {
		requireChannel(params.channelId);
		return hooks.state.channelInvites(params.channelId);
	});
	rest.intercept(Routes.listGuildInvites, (_pending, params) => {
		requireGuild(params.guildId);
		return hooks.state.guildInvites(params.guildId);
	});
	rest.intercept(Routes.fetchInvite, (_pending, params) => {
		const invite = hooks.state.invite(params.code);
		if (!invite && world) apiError(404, ErrorCode.UnknownInvite, 'Unknown Invite');
		return invite ?? apiInvite({ code: params.code });
	});
	rest.intercept(Routes.deleteInvite, (_pending, params) => {
		if (world && !hooks.state.invite(params.code)) apiError(404, ErrorCode.UnknownInvite, 'Unknown Invite');
		return hooks.state.removeInvite(params.code) ?? apiInvite({ code: params.code });
	});
	rest.intercept(Routes.bulkBan, async (pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.BanMembers);
		const rawIds = bodyRecord(pending.body).user_ids;
		const userIds = (Array.isArray(rawIds) ? rawIds : []).map(String);
		// Bulk-ban is partial-success, not atomic: targets the bot can't outrank go to failed_users, the rest ban.
		const banned: string[] = [];
		const failed: string[] = [];
		for (const userId of userIds) {
			try {
				requireHierarchy(params.guildId, userId);
			} catch (error) {
				if (error instanceof MockApiError) {
					failed.push(userId);
					continue;
				}
				throw error;
			}
			await removeMember(params.guildId, userId, true);
			await hooks.cacheSet('bans', userId, params.guildId, { reason: null, user: resolveUser(userId) });
			banned.push(userId);
		}
		return { banned_users: banned, failed_users: failed };
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
		parentGuard: requireGuild,
		guard: (guildId: string) => {
			requireGuild(guildId);
			requirePerm(guildId, PermissionFlagsBits.ManageGuild);
		},
	});
	const resolveThreadUser = (userId: string) => (userId === '@me' ? hooks.botId : userId);
	rest.intercept(Routes.addThreadMember, (_pending, params) => {
		requireChannel(params.channelId);
		requireThreadPerm(
			params.channelId,
			params.userId === '@me' ? PermissionFlagsBits.ViewChannel : PermissionFlagsBits.SendMessagesInThreads,
		);
		hooks.state.addThreadMember(params.channelId, resolveThreadUser(params.userId));
		return {};
	});
	rest.intercept(Routes.removeThreadMember, (_pending, params) => {
		requireChannel(params.channelId);
		requireThreadPerm(
			params.channelId,
			params.userId === '@me' ? PermissionFlagsBits.ViewChannel : PermissionFlagsBits.SendMessagesInThreads,
		);
		hooks.state.removeThreadMember(params.channelId, resolveThreadUser(params.userId));
		return {};
	});
	rest.intercept(Routes.listThreadMembers, (_pending, params) => {
		requireChannel(params.channelId);
		requireThreadPerm(params.channelId, PermissionFlagsBits.ViewChannel);
		return hooks.state
			.threadMembers(params.channelId)
			.map(userId => apiThreadMember({ threadId: params.channelId, userId }));
	});
	rest.intercept(Routes.fetchThreadMember, (_pending, params) => {
		requireChannel(params.channelId);
		requireThreadPerm(params.channelId, PermissionFlagsBits.ViewChannel);
		const userId = resolveThreadUser(params.userId);
		const members = hooks.state.threadMembers(params.channelId);
		if (world && !members.includes(userId)) apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
		return apiThreadMember({ threadId: params.channelId, userId });
	});
	rest.intercept(Routes.fetchActiveThreads, (_pending, params) => {
		requireGuild(params.guildId);
		return {
			threads: hooks.state.activeThreads(params.guildId),
			members: [],
			has_more: false,
		};
	});
	registerGuildCrud(rest, {
		idParam: 'stickerId',
		create: Routes.createSticker,
		list: Routes.fetchStickers,
		fetch: Routes.fetchSticker,
		edit: Routes.editSticker,
		remove: Routes.deleteSticker,
		add: async (guildId, body) => {
			const entity = hooks.state.addSticker(guildId, body);
			await hooks.cacheSet('stickers', entity.id, guildId, entity);
			return entity;
		},
		all: guildId => hooks.state.stickers(guildId),
		one: (guildId, id) => hooks.state.sticker(guildId, id),
		patch: async (guildId, id, body) => {
			const entity = hooks.state.editSticker(guildId, id, body);
			if (entity) await hooks.cacheSet('stickers', id, guildId, entity);
			return entity;
		},
		drop: async (guildId, id) => {
			hooks.state.removeSticker(guildId, id);
			await hooks.cacheRemove('stickers', id, guildId);
		},
		fallback: (guildId, id) => apiSticker({ id, guildId }),
		parentGuard: requireGuild,
		guard: (guildId: string) => {
			requireGuild(guildId);
			requirePerm(guildId, PermissionFlagsBits.ManageGuildExpressions);
		},
		unknownCode: world ? ErrorCode.UnknownSticker : undefined,
		unknownMessage: 'Unknown Sticker',
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
		parentGuard: requireGuild,
		guard: (guildId: string) => {
			requireGuild(guildId);
			requirePerm(guildId, PermissionFlagsBits.ManageEvents);
		},
		unknownCode: world ? ErrorCode.UnknownScheduledEvent : undefined,
		unknownMessage: 'Unknown Guild Scheduled Event',
	});
	rest.intercept(Routes.listGuildTemplates, (_pending, params) => {
		requireGuild(params.guildId);
		return hooks.state.guildTemplates(params.guildId);
	});
	rest.intercept(Routes.createGuildTemplate, (pending, params) => {
		requireGuild(params.guildId);
		return hooks.state.addGuildTemplate(params.guildId, bodyRecord(pending.body));
	});
	rest.intercept(Routes.fetchGuildTemplate, (_pending, params) => {
		const template = hooks.state.guildTemplate(params.code);
		if (!template && world) apiError(404, ErrorCode.UnknownGuildTemplate, 'Unknown Guild Template');
		return template ?? apiGuildTemplate({ code: params.code });
	});
	rest.intercept(Routes.listGuildSoundboardSounds, (_pending, params) => {
		requireGuild(params.guildId);
		return { items: hooks.state.soundboardSounds(params.guildId) };
	});
	rest.intercept(Routes.listDefaultSoundboardSounds, () => []);
	rest.intercept(Routes.createStageInstance, async pending => {
		const stageBody = bodyRecord(pending.body);
		const channelId = String(stageBody.channel_id ?? '');
		requireChannel(channelId);
		requireChannelPerm(channelId, PermissionFlagsBits.ManageChannels);
		const stage = hooks.state.addStageInstance(stageBody);
		await cacheStage(stage);
		return stage;
	});
	interceptFetchOne(
		rest,
		Routes.fetchStageInstance,
		params => {
			requireChannel(params.channelId);
			return hooks.state.stageInstance(params.channelId);
		},
		params => apiStageInstance({ channelId: params.channelId }),
		world ? { code: ErrorCode.UnknownStageInstance, message: 'Unknown Stage Instance' } : undefined,
	);
	rest.intercept(Routes.deleteStageInstance, async (_pending, params) => {
		requireChannel(params.channelId);
		const stage = hooks.state.stageInstance(params.channelId);
		if (world && !stage) {
			apiError(404, ErrorCode.UnknownStageInstance, 'Unknown Stage Instance');
		}
		hooks.state.removeStageInstance(params.channelId);
		await removeCachedStage(params.channelId, stage?.guild_id ?? guildOfChannel(params.channelId));
		return {};
	});
	rest.intercept(Routes.fetchAuditLogs, (_pending, params) => {
		requireGuild(params.guildId);
		return {
			audit_log_entries: hooks.state.auditLogEntries(params.guildId),
			users: [],
			auto_moderation_rules: [],
			guild_scheduled_events: [],
			integrations: [],
			threads: [],
			webhooks: [],
		};
	});
	rest.intercept(Routes.editGuild, (pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.ManageGuild);
		const updated = hooks.state.editGuild(params.guildId, bodyRecord(pending.body));
		return updated ?? { ...apiGuild({ id: params.guildId }), ...bodyRecord(pending.body) };
	});
	rest.intercept(Routes.fetchBan, (_pending, params) => {
		requireGuild(params.guildId);
		if (!hooks.state.isBanned(params.guildId, params.userId)) {
			return apiError(404, ErrorCode.UnknownBan, 'Unknown Ban');
		}
		return { user: resolveUser(params.userId) };
	});
	rest.intercept(Routes.ban, async (_pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.BanMembers);
		requireHierarchy(params.guildId, params.userId);
		await removeMember(params.guildId, params.userId, true);
		await hooks.cacheSet('bans', params.userId, params.guildId, { reason: null, user: resolveUser(params.userId) });
		return {};
	});
	rest.intercept(Routes.kick, async (_pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.KickMembers);
		if (world && !findMember(params.guildId, params.userId)) apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
		requireHierarchy(params.guildId, params.userId);
		await removeMember(params.guildId, params.userId, false);
		return {};
	});
	rest.intercept(Routes.unban, async (_pending, params) => {
		requireGuild(params.guildId);
		requirePerm(params.guildId, PermissionFlagsBits.BanMembers);
		if (world && !hooks.state.isBanned(params.guildId, params.userId)) {
			apiError(404, ErrorCode.UnknownBan, 'Unknown Ban');
		}
		hooks.state.unban(params.guildId, params.userId);
		await hooks.cacheRemove('bans', params.userId, params.guildId);
		return {};
	});
	rest.intercept(Routes.fetchBans, (_pending, params) => {
		requireGuild(params.guildId);
		return hooks.state.bans(params.guildId).map(userId => ({
			user: resolveUser(userId),
		}));
	});
	rest.intercept(Routes.editChannel, async (pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageChannels);
		const updated = hooks.state.editChannel(params.channelId, bodyRecord(pending.body));
		if (updated) await cacheChannel(updated);
		await syncOverwriteCache(params.channelId);
		return updated ?? { ...apiChannel({ id: params.channelId }), ...bodyRecord(pending.body) };
	});
	rest.intercept(Routes.editChannelPermissions, async (pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageRoles);
		hooks.state.setChannelOverwrite(params.channelId, params.overwriteId, bodyRecord(pending.body));
		await syncOverwriteCache(params.channelId);
		return {};
	});
	rest.intercept(Routes.deleteChannelPermission, async (_pending, params) => {
		requireChannel(params.channelId);
		requireChannelPerm(params.channelId, PermissionFlagsBits.ManageRoles);
		hooks.state.removeChannelOverwrite(params.channelId, params.overwriteId);
		await syncOverwriteCache(params.channelId);
		return {};
	});
	rest.intercept(Routes.triggerTyping, (_pending, params) => {
		requireChannel(params.channelId);
		return {};
	});

	const reactionEventBase = (channelId: string, messageId: string) => {
		const message = hooks.state.rawMessage(channelId, messageId);
		const guildId = world?.channels.find(channel => channel.id === channelId)?.guild_id ?? message?.guild_id;
		return {
			channel_id: channelId,
			message_id: messageId,
			...(guildId === undefined ? {} : { guild_id: guildId }),
			...(message?.author?.id === undefined ? {} : { message_author_id: message.author.id }),
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
		const base = reactionEventBase(channelId, messageId);
		const guildId = typeof base.guild_id === 'string' ? base.guild_id : undefined;
		const member = guildId ? findMember(guildId, userId)?.member : undefined;
		await hooks.emit(name, {
			...(name === 'MESSAGE_REACTION_ADD'
				? messageReactionAddEvent(
						{ channelId, messageId, userId, emoji },
						{
							...(guildId === undefined ? {} : { guildId }),
							...(member === undefined ? {} : { member }),
							...(typeof base.message_author_id === 'string' ? { messageAuthorId: base.message_author_id } : {}),
						},
					)
				: {
						...base,
						user_id: userId,
						emoji: emojiPayload(emoji),
					}),
		});
	};

	rest.intercept(Routes.addReaction, async (_pending, params) => {
		if (!hooks.state.rawMessage(params.channelId, params.messageId))
			apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		hooks.state.addReaction(params.channelId, params.messageId, params.emoji, hooks.botId);
		await emitReaction('MESSAGE_REACTION_ADD', params.channelId, params.messageId, params.emoji, hooks.botId);
		return {};
	});
	// Reaction REMOVAL parity with addReaction: a reaction op against a message that does not exist is a 404,
	// not a silent no-op. Only the message's existence is gated (removing an absent reaction from a real
	// message is a legit no-op), mirroring Discord.
	rest.intercept(Routes.removeOwnReaction, async (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		hooks.state.removeReaction(params.channelId, params.messageId, params.emoji, hooks.botId);
		await emitReaction('MESSAGE_REACTION_REMOVE', params.channelId, params.messageId, params.emoji, hooks.botId);
		return {};
	});
	rest.intercept(Routes.removeUserReaction, async (_pending, params) => {
		// `@me` collides with the own-reaction route shape; route it to the bot user for parity.
		const userId = params.userId === '@me' ? hooks.botId : params.userId;
		requireMessage(params.channelId, params.messageId);
		hooks.state.removeReaction(params.channelId, params.messageId, params.emoji, userId);
		await emitReaction('MESSAGE_REACTION_REMOVE', params.channelId, params.messageId, params.emoji, userId);
		return {};
	});
	rest.intercept(Routes.removeEmojiReactions, async (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
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
		requireMessage(params.channelId, params.messageId);
		hooks.state.removeAllReactions(params.channelId, params.messageId);
		if (hooks.simulateGateway) {
			await hooks.emit('MESSAGE_REACTION_REMOVE_ALL', reactionEventBase(params.channelId, params.messageId));
		}
		return {};
	});
	rest.intercept(Routes.listReactions, (_pending, params) => {
		requireMessage(params.channelId, params.messageId);
		return hooks.state
			.reactionUsers(params.channelId, params.messageId, params.emoji)
			.map(userId => resolveUser(userId));
	});
	const interceptRoleMutation = (
		route: RouteMatcher,
		mutate: (member: ApiMember, roleId: string) => string[] | undefined,
	) =>
		rest.intercept(route, async (_pending, params) => {
			requireGuild(params.guildId);
			if (params.roleId === params.guildId) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: the @everyone role cannot be added or removed');
			}
			requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
			if (world && !guildRolesOf(params.guildId).some(role => role.id === params.roleId)) {
				apiError(404, ErrorCode.UnknownRole, 'Unknown Role');
			}
			requireManageableRole(params.guildId, params.roleId);
			const entry = findMember(params.guildId, params.userId);
			if (world && !entry) apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
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
		requireGuild(params.guildId);
		const entry = findMember(params.guildId, params.userId);
		if (!entry) {
			if (world) apiError(404, ErrorCode.UnknownMember, 'Unknown Member');
			return apiMember({ user: apiUser({ id: params.userId }) });
		}
		const body = bodyRecord(pending.body) as {
			nick?: string | null;
			roles?: string[];
			communication_disabled_until?: string | null;
		};
		if ('nick' in body) requirePerm(params.guildId, PermissionFlagsBits.ManageNicknames);
		if (body.roles) requirePerm(params.guildId, PermissionFlagsBits.ManageRoles);
		if ('communication_disabled_until' in body) requirePerm(params.guildId, PermissionFlagsBits.ModerateMembers);
		requireHierarchy(params.guildId, params.userId);
		// Every role being added OR removed must be manageable (below the bot's top role); @everyone can't be set.
		if (body.roles) {
			const next = new Set(body.roles);
			const current = new Set(entry.member.roles);
			for (const roleId of new Set([...next, ...current])) {
				if (next.has(roleId) === current.has(roleId)) continue; // unchanged
				if (roleId === params.guildId) {
					apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: the @everyone role cannot be assigned');
				}
				requireManageableRole(params.guildId, roleId);
			}
		}
		hooks.state.patchMember(params.guildId, params.userId, body);
		if ('nick' in body) entry.member.nick = body.nick ?? null;
		if (body.roles) entry.member.roles = [...body.roles];
		if ('communication_disabled_until' in body)
			entry.member.communication_disabled_until = body.communication_disabled_until;
		await emitMemberUpdate(params.guildId, entry.member);
		return entry.member;
	});

	for (const [name, coverage] of Object.entries(ROUTE_COVERAGE) as [
		keyof typeof Routes,
		(typeof ROUTE_COVERAGE)[keyof typeof ROUTE_COVERAGE],
	][]) {
		if (coverage !== 'handled') continue;
		if (!rest.hasInterceptor(Routes[name])) {
			throw new Error(
				`registerWorldDefaults: ROUTE_COVERAGE marks Routes.${String(name)} handled, but no interceptor was registered.`,
			);
		}
	}
}
