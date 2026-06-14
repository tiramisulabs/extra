import type { UsingClient } from 'seyfert';
import { CacheFrom } from 'seyfert/lib/cache';
import { TEST_BOT_ID } from './constants';
import {
	type ApiChannel,
	type ApiChannelOptions,
	type ApiGuild,
	type ApiGuildOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiMessageOptions,
	type ApiRole,
	type ApiRoleOptions,
	type ApiUser,
	type ApiUserOptions,
	apiChannel,
	apiGuild,
	apiMember,
	apiMessage,
	apiRole,
	apiUser,
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

export class WorldBuilder {
	private readonly world: MockWorld = { guilds: [], channels: [], users: [], members: [], roles: [], messages: [] };

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

	registerBotMember(guildId: string, options: { roles?: string[]; botId?: string } = {}): ApiMember {
		return this.registerMember(guildId, {
			user: apiUser({ id: options.botId ?? TEST_BOT_ID, bot: true, username: TEST_BOT_ID }),
			roles: options.roles,
		});
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
}
