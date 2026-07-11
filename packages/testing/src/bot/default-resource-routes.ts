import { PermissionFlagsBits } from 'seyfert';
import type { WorldDefaultContext } from './default-context';
import { bodyRecord, interceptFetchOne, registerGuildCrud } from './default-context';
import { emojiPayload } from './emoji';
import {
	type ApiMember,
	apiAutoModRule,
	apiChannel,
	apiEmoji,
	apiGuild,
	apiGuildTemplate,
	apiInvite,
	apiMember,
	apiRole,
	apiScheduledEvent,
	apiStageInstance,
	apiSticker,
	apiThreadMember,
	apiUser,
	messageReactionAddEvent,
} from './payloads';
import { apiError, ErrorCode, MockApiError, type RouteMatcher } from './rest';
import { ROUTE_COVERAGE, Routes } from './routes';

export function registerWorldResourceRoutes(context: WorldDefaultContext): void {
	const {
		rest,
		world,
		hooks,
		findMember,
		emitMemberUpdate,
		removeMember,
		resolveUser,
		guildOfChannel,
		cacheChannel,
		cacheRole,
		removeCachedRole,
		cacheStage,
		removeCachedStage,
		syncOverwriteCache,
		requireGuild,
		requireChannel,
		requireMessage,
		guildRolesOf,
		requirePerm,
		requireChannelPerm,
		requireThreadPerm,
		requireHierarchy,
		requireManageableRole,
	} = context;

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
