import type { UsingClient } from 'seyfert';
import { CacheFrom } from 'seyfert/lib/cache';
import {
	type ApiChannel,
	type ApiChannelOptions,
	type ApiGuild,
	type ApiGuildOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiUser,
	type ApiUserOptions,
	apiChannel,
	apiGuild,
	apiMember,
	apiUser,
} from './payloads';

export interface MockWorld {
	guilds: ApiGuild[];
	channels: ApiChannel[];
	users: ApiUser[];
	members: { guildId: string; member: ApiMember }[];
}

export class WorldBuilder {
	private readonly world: MockWorld = { guilds: [], channels: [], users: [], members: [] };

	registerGuild(options: ApiGuildOptions = {}): ApiGuild {
		const guild = apiGuild(options);
		this.world.guilds.push(guild);
		return guild;
	}

	registerChannel(guildId: string, options: Omit<ApiChannelOptions, 'guildId'> = {}): ApiChannel {
		const channel = apiChannel({ ...options, guildId });
		this.world.channels.push(channel);
		return channel;
	}

	registerUser(options: ApiUserOptions = {}): ApiUser {
		const user = apiUser(options);
		this.world.users.push(user);
		return user;
	}

	registerMember(guildId: string, options: ApiMemberOptions = {}): ApiMember {
		const member = apiMember(options);
		this.world.members.push({ guildId, member });
		if (!this.world.users.some(user => user.id === member.user.id)) {
			this.world.users.push(member.user);
		}
		return member;
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
	for (const user of world.users) {
		await client.cache.users?.set(CacheFrom.Test, user.id, user);
	}
	for (const entry of world.members) {
		await client.cache.members?.set(CacheFrom.Test, entry.member.user.id, entry.guildId, entry.member);
	}
}
