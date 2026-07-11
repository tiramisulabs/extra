import { PermissionFlagsBits } from 'seyfert';
import { type ApiMember, apiChannel, apiGuild, apiUser } from './payloads';
import { computeChannelPermissions } from './permissions';
import { apiError, ErrorCode, type MockApiHandler, type RouteMatcher } from './rest';
import { Routes } from './routes';
import type { MessageQuery, WorldState } from './state';
import type { MockWorld } from './world';
import type { WorldEmitEvent } from './world-events';

export type CacheResourceName = 'channels' | 'roles' | 'stageInstances' | 'emojis' | 'stickers' | 'overwrites' | 'bans';

export interface WorldDefaultHooks {
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

export function bodyRecord(body: Record<string, unknown> | undefined): Record<string, unknown> {
	return body ?? {};
}

export function queryString(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	return undefined;
}

export function messageQuery(query: Record<string, unknown> | undefined): MessageQuery {
	if (!query) return {};
	const limit = queryString(query.limit);
	return {
		...(limit === undefined ? {} : { limit: Number(limit) }),
		...(queryString(query.before) === undefined ? {} : { before: queryString(query.before) }),
		...(queryString(query.after) === undefined ? {} : { after: queryString(query.after) }),
		...(queryString(query.around) === undefined ? {} : { around: queryString(query.around) }),
	};
}

export function memberListLimit(query: Record<string, unknown> | undefined): number {
	const requested = Number(queryString(query?.limit) ?? 1);
	if (!Number.isFinite(requested)) return 1;
	return Math.max(1, Math.min(1000, Math.trunc(requested)));
}

export function interceptFetchOne<T>(
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
export interface GuildCrudConfig {
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

export function registerGuildCrud(rest: MockApiHandler, config: GuildCrudConfig): void {
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
export const WEBHOOK_ID_PREFIX = 'wh-';
export function webhookChannelOf(webhookId: string): string | undefined {
	return webhookId.startsWith(WEBHOOK_ID_PREFIX) ? webhookId.slice(WEBHOOK_ID_PREFIX.length) : undefined;
}
export function createWorldDefaultContext(
	rest: MockApiHandler,
	world: MockWorld | undefined,
	hooks: WorldDefaultHooks,
) {
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
	return {
		rest,
		world,
		hooks,
		removed,
		key,
		findMember,
		emitMemberUpdate,
		removeMember,
		resolveUser,
		guildOfChannel,
		channelPermissionTarget,
		cacheChannel,
		removeCachedChannel,
		cacheRole,
		removeCachedRole,
		cacheStage,
		removeCachedStage,
		syncOverwriteCache,
		requireGuild,
		requireChannel,
		requireMessage,
		guildRolesOf,
		botMemberOf,
		botGuildPerms,
		requirePerm,
		requireChannelPerm,
		requireThreadPerm,
		topRole,
		requireHierarchy,
		requireManageableRole,
	};
}
export type WorldDefaultContext = ReturnType<typeof createWorldDefaultContext>;
