import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { type ApiUser, createMockBot, mockWorld, richUser, TEST_BOT_ID, TEST_USER_ID } from '../../src';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld as internalMockWorld } from '../../src/bot/world';

@Declare({ name: 'whoami', description: 'Reports who is running it and where' })
class WhoAmI extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: `${ctx.author.id}@${ctx.guildId}` });
	}
}

@Declare({ name: 'where-here', description: 'Reports the channel it ran in' })
class WhereHere extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: `${ctx.channelId}` });
	}
}

@Declare({ name: 'ban-target', description: 'Bans the seeded target' })
class BanTarget extends Command {
	async run(ctx: CommandContext) {
		await ctx.client.members.ban(ctx.guildId ?? '', 'identity-target');
		await ctx.write({ content: 'banned' });
	}
}

describe('bot identity is stated once', () => {
	test('a botId given to createMockBot reaches the member the world already seeded', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'identity-guild' });
		const botMember = world.registerBotMember(guild.id);

		await using bot = await createMockBot({ world, botId: 'scenario-bot' });

		expect(bot.client.botId).toBe('scenario-bot');
		expect(botMember.user.id).toBe('scenario-bot');
		expect(bot.world.query.member({ guildId: guild.id, userId: 'scenario-bot' })).toBeDefined();
	});

	test('a botId pinned on the world reaches the client', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'pinned-guild' });
		const botMember = world.registerBotMember(guild.id, { botId: 'pinned-bot' });

		await using bot = await createMockBot({ world });

		expect(bot.client.botId).toBe('pinned-bot');
		expect(botMember.user.id).toBe('pinned-bot');
	});

	test('a message authored by the seeded bot member answers "did I write this?"', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'authored-guild' });
		const botMember = world.registerBotMember(guild.id);
		const channel = world.registerChannel(guild.id);
		const source = world.registerMessage(channel.id, { author: botMember.user });

		await using bot = await createMockBot({ world, botId: 'scenario-bot' });

		expect(source.author.id).toBe(bot.client.botId);
	});

	test('permission enforcement still finds the bot member under a custom botId', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'enforce-identity-guild', ownerId: 'enforce-identity-owner' });
		const channel = world.registerChannel(guild.id);
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'identity-actor' }) });
		const botRole = world.registerRole(guild.id, { id: 'identity-bot-role', position: 5 });
		const targetRole = world.registerRole(guild.id, { id: 'identity-target-role', position: 1 });
		world.registerBotMember(guild.id, { roles: [botRole.id] });
		world.registerMember(guild.id, { user: apiUser({ id: 'identity-target' }), roles: [targetRole.id] });

		await using bot = await createMockBot({ commands: [BanTarget], world, botId: 'scenario-bot' });

		// The bot role carries no BanMembers. Enforcement is opt-in via the seeded bot member, so if the custom
		// botId leaves that member unreachable the ban silently succeeds instead of being rejected.
		await expect(bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user })).rejects.toThrow(
			/Missing Permissions/,
		);
	});

	test('two contradictory bot ids fail loudly instead of diverging', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'conflict-guild' });
		world.registerBotMember(guild.id, { botId: 'world-bot' });

		await expect(createMockBot({ world, botId: 'options-bot' })).rejects.toThrow(
			/conflicts with registerBotMember\(\{ botId: "world-bot" \}\)/,
		);
	});

	test('pinning two different bot ids on one world fails at registration', () => {
		const world = mockWorld();
		const first = world.registerGuild({ id: 'multi-guild-a' });
		const second = world.registerGuild({ id: 'multi-guild-b' });
		world.registerBotMember(first.id, { botId: 'one-bot' });

		expect(() => world.registerBotMember(second.id, { botId: 'other-bot' })).toThrow(/already pinned/);
	});

	test('one bot across two guilds keeps a single id', async () => {
		const world = mockWorld();
		const first = world.registerGuild({ id: 'shared-a' });
		const second = world.registerGuild({ id: 'shared-b' });
		const here = world.registerBotMember(first.id);
		const there = world.registerBotMember(second.id);

		await using bot = await createMockBot({ world, botId: 'shared-bot' });

		expect([here.user.id, there.user.id]).toEqual(['shared-bot', 'shared-bot']);
		expect(bot.client.botId).toBe('shared-bot');
	});

	test('the bot member gets a readable username, not its own snowflake', () => {
		const world = internalMockWorld();
		const guild = world.registerGuild({ id: 'username-guild' });
		const member = world.registerBotMember(guild.id);

		expect(member.user.username).toBe('slipher-test-bot');
		expect(member.user.username).not.toBe(TEST_BOT_ID);
		expect(member.user.username).not.toBe(member.user.id);
	});

	test('adoptBotId restates the member, the users entry and the built world', () => {
		const world = internalMockWorld();
		const guild = world.registerGuild({ id: 'adopt-guild' });
		const member = world.registerBotMember(guild.id);

		expect(world.adoptBotId('adopted-bot')).toBe('adopted-bot');

		expect(member.user.id).toBe('adopted-bot');
		const built = world.build();
		expect(built.users.map(user => user.id)).toContain('adopted-bot');
		expect(built.members[0]?.member.user.id).toBe('adopted-bot');
	});

	test('adoptBotId leaves the default in place when nobody stated an id', () => {
		const world = internalMockWorld();
		const guild = world.registerGuild({ id: 'default-adopt-guild' });
		const member = world.registerBotMember(guild.id);

		expect(world.adoptBotId(undefined)).toBeUndefined();
		expect(member.user.id).toBe(TEST_BOT_ID);
	});
});

describe('default dispatch identity follows the world', () => {
	test('a world with one human member dispatches as that member', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'sole-guild' });
		const channel = world.registerChannel(guild.id);
		world.registerBotMember(guild.id);
		const member = world.registerMember(guild.id, { nick: 'sole' });

		await using bot = await createMockBot({ commands: [WhoAmI], world });

		expect(bot.defaultUser.id).toBe(member.user.id);
		await expect(bot.slash({ name: 'whoami', guildId: guild.id, channel })).resolves.toMatchObject({
			content: `${member.user.id}@${guild.id}`,
		});
	});

	test('one person seeded in two guilds is still the sole default', async () => {
		const world = mockWorld();
		const first = world.registerGuild({ id: 'person-a' });
		const second = world.registerGuild({ id: 'person-b' });
		const user = apiUser({ id: 'travelling-user' });
		world.registerMember(first.id, { user });
		world.registerMember(second.id, { user });

		await using bot = await createMockBot({ world });

		expect(bot.defaultUser.id).toBe('travelling-user');
	});

	test('several human members keep the canonical default', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'crowd-guild' });
		world.registerMember(guild.id, { user: apiUser({ id: 'crowd-one' }) });
		world.registerMember(guild.id, { user: apiUser({ id: 'crowd-two' }) });

		await using bot = await createMockBot({ world });

		expect(bot.defaultUser.id).toBe(TEST_USER_ID);
	});

	test('no world keeps the canonical default', async () => {
		await using bot = await createMockBot({});

		expect(bot.defaultUser.id).toBe(TEST_USER_ID);
	});
});

describe('actor binding is checked against the world', () => {
	const seedActorWorld = () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'actor-guild' });
		const channel = world.registerChannel(guild.id);
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'actor-user' }) });
		return { world, guild, channel, member };
	};

	test('a seeded user alone is enough to resolve the guild', async () => {
		const { world, guild, member } = seedActorWorld();
		await using bot = await createMockBot({ commands: [WhoAmI], world });

		await expect(bot.actor({ user: member.user }).slash({ name: 'whoami' })).resolves.toMatchObject({
			content: `${member.user.id}@${guild.id}`,
		});
	});

	test('a guildId the member does not belong to is rejected', async () => {
		const { world, member } = seedActorWorld();
		world.registerGuild({ id: 'other-guild' });
		await using bot = await createMockBot({ commands: [WhoAmI], world });

		expect(() => bot.actor({ member, guildId: 'other-guild' })).toThrow(/is not a member of guild "other-guild"/);
	});

	test('a channel from another guild is rejected', async () => {
		const { world, member } = seedActorWorld();
		const other = world.registerGuild({ id: 'elsewhere-guild' });
		const elsewhere = world.registerChannel(other.id);
		await using bot = await createMockBot({ commands: [WhoAmI], world });

		expect(() => bot.actor({ member, channel: elsewhere })).toThrow(/belongs to guild "elsewhere-guild"/);
	});

	test('the sole channel in the guild is derived', async () => {
		const { world, channel, member } = seedActorWorld();
		await using bot = await createMockBot({ commands: [WhereHere], world });

		await expect(bot.actor({ member }).slash({ name: 'where-here' })).resolves.toMatchObject({
			content: channel.id,
		});
	});

	test('several channels must be disambiguated instead of picked by seeding order', async () => {
		const { world, guild, member } = seedActorWorld();
		guild.registerChannel({ id: 'second-channel' });
		await using bot = await createMockBot({ commands: [WhereHere], world });

		expect(() => bot.actor({ member })).toThrow(/has 2 channels/);
	});

	test('an explicit channel resolves the ambiguity', async () => {
		const { world, guild, member } = seedActorWorld();
		const second = guild.registerChannel({ id: 'second-channel' });
		await using bot = await createMockBot({ commands: [WhereHere], world });

		await expect(bot.actor({ member, channel: second }).slash({ name: 'where-here' })).resolves.toMatchObject({
			content: 'second-channel',
		});
	});

	test('a thread does not count as a second channel', async () => {
		const { world, channel, member } = seedActorWorld();
		world.registerThread(channel.id, { id: 'actor-thread' });
		await using bot = await createMockBot({ commands: [WhereHere], world });

		await expect(bot.actor({ member }).slash({ name: 'where-here' })).resolves.toMatchObject({
			content: channel.id,
		});
	});

	test('a member of several guilds must say which one', async () => {
		const world = mockWorld();
		const first = world.registerGuild({ id: 'ambiguous-a' });
		const second = world.registerGuild({ id: 'ambiguous-b' });
		const user = apiUser({ id: 'ambiguous-user' });
		world.registerMember(first.id, { user });
		const member = world.registerMember(second.id, { user });
		await using bot = await createMockBot({ commands: [WhoAmI], world });

		expect(() => bot.actor({ member })).toThrow(/is a member of 2 guilds/);
		expect(() => bot.actor({ member, guildId: second.id })).not.toThrow();
	});
});

describe('a lightweight fixture seeded into a world fails legibly', () => {
	test('richUser in registerMember names both factories instead of DataCloneError', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fixture-guild' });
		// Typechecks: RichUser satisfies ApiUser structurally, so nothing stops this at compile time.
		world.registerMember(guild.id, { user: richUser({ id: 'fixture-user' }) as ApiUser });

		await expect(createMockBot({ world })).rejects.toThrow(/apiUser/);
		await expect(createMockBot({ world })).rejects.toThrow(/mockCommandContext/);
		// the underlying cause is preserved, not swallowed
		await expect(createMockBot({ world })).rejects.toThrow(/could not be cloned/);
	});

	test('the payload factory it points at works', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'payload-user-guild' });
		world.registerMember(guild.id, { user: apiUser({ id: 'payload-user' }) });

		await using bot = await createMockBot({ world });
		expect(bot.world.query.member({ guildId: guild.id, userId: 'payload-user' })).toBeDefined();
	});
});
