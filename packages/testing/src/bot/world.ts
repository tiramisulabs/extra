import type { UsingClient } from 'seyfert';
import { CacheFrom } from 'seyfert/lib/cache';
import { TEST_BOT_ID } from './constants';
import {
	type ApiAutoModRule,
	type ApiAutoModRuleOptions,
	type ApiChannel,
	type ApiChannelOptions,
	type ApiEmoji,
	type ApiEmojiOptions,
	type ApiGuild,
	type ApiGuildOptions,
	type ApiInvite,
	type ApiInviteOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiMessageOptions,
	type ApiRole,
	type ApiRoleOptions,
	type ApiThreadOptions,
	type ApiUser,
	type ApiUserOptions,
	type ApiVoiceState,
	type ApiVoiceStateOptions,
	type ApiWebhook,
	type ApiWebhookOptions,
	apiAutoModRule,
	apiChannel,
	apiEmoji,
	apiGuild,
	apiInvite,
	apiWebhook,
	apiMember,
	apiMessage,
	apiRole,
	apiThread,
	apiUser,
	apiVoiceState,
} from './payloads';
import type { PermissionInput } from './permissions';
import { permissionBits } from './permissions';

export interface MockWorld {
	guilds: ApiGuild[];
	channels: ApiChannel[];
	users: ApiUser[];
	members: { guildId: string; member: ApiMember }[];
	roles: { guildId: string; role: ApiRole }[];
	messages: { channelId: string; message: ApiMessage }[];
	voiceStates?: { guildId: string; voiceState: ApiVoiceState }[];
	guildEmojis?: { guildId: string; emoji: ApiEmoji }[];
	invites?: ApiInvite[];
	autoModRules?: { guildId: string; rule: ApiAutoModRule }[];
	webhooks?: ApiWebhook[];
	/**
	 * App-specific key/value store, untouched by the mock. A domain layer seeds its own state here (and a test
	 * reads it back via {@link MockBot.worldData}); the mock never interprets or mutates it. Pure passthrough.
	 */
	data?: Record<string, unknown>;
}

export type ChannelOverwriteInput = {
	id: string;
	type: 'role' | 'member';
	allow?: PermissionInput;
	deny?: PermissionInput;
};

export type WorldChannelOptions = Omit<ApiChannelOptions, 'guildId' | 'permissionOverwrites'> & {
	overwrites?: ChannelOverwriteInput[];
};

export type WorldRoleOptions = Omit<ApiRoleOptions, 'permissions'> & {
	permissions?: PermissionInput;
};

export type WorldGuildOptions = ApiGuildOptions & {
	everyonePermissions?: PermissionInput;
};

export type WorldThreadOptions = Omit<ApiThreadOptions, 'parentId' | 'guildId'>;

export type WorldEmojiOptions = Omit<ApiEmojiOptions, 'guildId'>;

export type WorldInviteOptions = Omit<ApiInviteOptions, 'channelId' | 'guildId'>;

export class WorldBuilder {
	private readonly world: MockWorld = {
		guilds: [],
		channels: [],
		users: [],
		members: [],
		roles: [],
		messages: [],
		voiceStates: [],
		guildEmojis: [],
		invites: [],
		autoModRules: [],
		webhooks: [],
	};

	private requireGuild(guildId: string): void {
		if (this.world.guilds.some(guild => guild.id === guildId)) return;
		const seeded = this.world.guilds.map(guild => guild.id).join(', ') || '(none)';
		throw new TypeError(`mockWorld: guild "${guildId}" is not registered. Seeded guilds: ${seeded}.`);
	}

	private requireChannel(channelId: string): void {
		if (this.world.channels.some(channel => channel.id === channelId)) return;
		const seeded = this.world.channels.map(channel => channel.id).join(', ') || '(none)';
		throw new TypeError(`mockWorld: channel "${channelId}" is not registered. Seeded channels: ${seeded}.`);
	}

	registerGuild(options: WorldGuildOptions = {}): ApiGuild {
		const guild = apiGuild(options);
		this.world.guilds.push(guild);
		this.world.roles.push({
			guildId: guild.id,
			role: apiRole({
				id: guild.id,
				name: '@everyone',
				permissions: permissionBits(options.everyonePermissions ?? '0'),
				position: 0,
			}),
		});
		return guild;
	}

	registerRole(guildId: string, options: WorldRoleOptions = {}): ApiRole {
		this.requireGuild(guildId);
		const role = apiRole({
			...options,
			permissions: permissionBits(options.permissions ?? '0'),
		});
		this.world.roles.push({ guildId, role });
		return role;
	}

	registerChannel(guildId: string, options: WorldChannelOptions = {}): ApiChannel {
		this.requireGuild(guildId);
		const permissionOverwrites = (options.overwrites ?? []).map(overwrite => ({
			id: overwrite.id,
			type: overwrite.type === 'role' ? 0 : 1,
			allow: permissionBits(overwrite.allow ?? '0'),
			deny: permissionBits(overwrite.deny ?? '0'),
		}));
		const channel = apiChannel({ ...options, guildId, permissionOverwrites });
		this.world.channels.push(channel);
		return channel;
	}

	/**
	 * Register a thread under an existing channel. A thread is a channel of a thread type (default 11
	 * PublicThread) carrying the parent's `parent_id`, the parent's guild, and a `thread_metadata` block, so
	 * it coexists with normal channels yet stays distinguishable by those fields.
	 */
	registerThread(parentChannelId: string, options: WorldThreadOptions = {}): ApiChannel {
		this.requireChannel(parentChannelId);
		const parent = this.world.channels.find(channel => channel.id === parentChannelId);
		const thread = apiThread({
			...options,
			parentId: parentChannelId,
			guildId: parent?.guild_id ?? null,
		});
		this.world.channels.push(thread);
		return thread;
	}

	registerEmoji(guildId: string, options: WorldEmojiOptions = {}): ApiEmoji {
		this.requireGuild(guildId);
		const emoji = apiEmoji({ ...options, guildId });
		(this.world.guildEmojis ??= []).push({ guildId, emoji });
		return emoji;
	}

	registerInvite(channelId: string, options: WorldInviteOptions = {}): ApiInvite {
		this.requireChannel(channelId);
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const invite = apiInvite({ ...options, channelId, guildId: channel?.guild_id });
		(this.world.invites ??= []).push(invite);
		return invite;
	}

	registerAutoModRule(guildId: string, options: Omit<ApiAutoModRuleOptions, 'guildId'> = {}): ApiAutoModRule {
		this.requireGuild(guildId);
		const rule = apiAutoModRule({ ...options, guildId });
		(this.world.autoModRules ??= []).push({ guildId, rule });
		return rule;
	}

	registerWebhook(channelId: string, options: Omit<ApiWebhookOptions, 'channelId' | 'guildId'> = {}): ApiWebhook {
		this.requireChannel(channelId);
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const webhook = apiWebhook({
			applicationId: TEST_BOT_ID,
			...options,
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
		});
		(this.world.webhooks ??= []).push(webhook);
		return webhook;
	}

	registerUser(options: ApiUserOptions = {}): ApiUser {
		const user = apiUser(options);
		this.world.users.push(user);
		return user;
	}

	registerMember(guildId: string, options: ApiMemberOptions = {}): ApiMember {
		this.requireGuild(guildId);
		const member = apiMember(options);
		this.world.members.push({ guildId, member });
		if (!this.world.users.some(user => user.id === member.user.id)) {
			this.world.users.push(member.user);
		}
		return member;
	}

	registerVoiceState(guildId: string, options: ApiVoiceStateOptions = {}): ApiVoiceState {
		this.requireGuild(guildId);
		const voiceState = apiVoiceState(options);
		(this.world.voiceStates ??= []).push({ guildId, voiceState });
		return voiceState;
	}

	registerBotMember(guildId: string, options: { roles?: string[]; botId?: string } = {}): ApiMember {
		return this.registerMember(guildId, {
			user: apiUser({ id: options.botId ?? TEST_BOT_ID, bot: true, username: TEST_BOT_ID }),
			roles: options.roles,
		});
	}

	/**
	 * Attach an app-specific value under `key` in the world's passthrough data store, read back via
	 * {@link MockBot.worldData}. The mock never interprets it. Returns `this` for chaining.
	 */
	set(key: string, value: unknown): this {
		(this.world.data ??= {})[key] = value;
		return this;
	}

	registerMessage(channelId: string, options: Omit<ApiMessageOptions, 'channelId'> = {}): ApiMessage {
		this.requireChannel(channelId);
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const message = apiMessage({
			...options,
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
		});
		this.world.messages.push({ channelId, message });
		return message;
	}

	build(): MockWorld {
		return this.world;
	}
}

export function mockWorld(): WorldBuilder {
	return new WorldBuilder();
}

/** Writes a MockWorld into a Seyfert client's cache using CacheFrom.Test. */
export async function seedWorld(client: UsingClient, world: MockWorld): Promise<void> {
	for (const guild of world.guilds) {
		await client.cache.guilds?.set(CacheFrom.Test, guild.id, guild);
	}
	for (const channel of world.channels) {
		if (channel.guild_id) {
			await client.cache.channels?.set(CacheFrom.Test, channel.id, channel.guild_id, channel);
		}
	}
	for (const entry of world.roles) {
		await client.cache.roles?.set(CacheFrom.Test, entry.role.id, entry.guildId, entry.role);
	}
	for (const user of world.users) {
		await client.cache.users?.set(CacheFrom.Test, user.id, user);
	}
	for (const entry of world.members) {
		await client.cache.members?.set(CacheFrom.Test, entry.member.user.id, entry.guildId, entry.member);
	}
	for (const entry of world.voiceStates ?? []) {
		await client.cache.voiceStates?.set(CacheFrom.Test, entry.voiceState.user_id, entry.guildId, entry.voiceState);
	}
}
