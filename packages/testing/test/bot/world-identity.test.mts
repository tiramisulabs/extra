import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { type ApiUser, createMockBot, mockWorld, richUser, TEST_BOT_ID, TEST_USER_ID } from '../../src';
import { apiUser } from '../../src/bot/payloads';
import { DiscordErrors } from '../../src/bot/rest';
import { mockWorld as internalMockWorld } from '../../src/bot/world';
import { expectDiscordError } from './_setup';

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
	test('one configured profile authors seeded, REST, and interaction messages across guilds', async () => {
		const world = mockWorld();
		const identity = world.botUser({
			id: '900000000000000099',
			username: 'my-bot',
			globalName: 'My Bot',
			avatar: 'avatar-hash',
		});
		const first = world.registerGuild({ id: 'profile-a' });
		const second = world.registerGuild({ id: 'profile-b' });
		const here = world.registerBotMember(first.id);
		const there = world.registerBotMember(second.id);
		const channel = world.registerChannel(first.id, { id: 'profile-channel' });
		const actor = world.registerMember(first.id, { user: apiUser({ id: 'profile-actor' }) });
		world.registerMessage(channel.id, { author: world.botUser(), content: 'seeded' });

		@Declare({ name: 'identity', description: 'Replies as the bot' })
		class Identity extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'original' });
				await ctx.followup({ content: 'followup' });
				await ctx.editResponse({ content: 'edited original' });
			}
		}

		await using bot = await createMockBot({ world, commands: [Identity] });
		const expected = {
			id: identity.id,
			username: 'my-bot',
			global_name: 'My Bot',
			avatar: 'avatar-hash',
			bot: true,
		};
		expect(bot.client.botId).toBe(identity.id);
		expect(bot.world.snapshot().botUser).toMatchObject(expected);
		expect(bot.client.me).toMatchObject({
			id: identity.id,
			username: 'my-bot',
			globalName: 'My Bot',
			avatar: 'avatar-hash',
			bot: true,
		});
		expect(here.user).toMatchObject(expected);
		expect(there.user).toMatchObject(expected);
		const rest = await bot.client.messages.write(channel.id, { content: 'REST' });
		await bot.client.messages.edit(rest.id, channel.id, { content: 'REST edited' });
		await bot.slash({ name: 'identity', guildId: first.id, channel, user: actor.user });
		for (const content of ['seeded', 'REST edited', 'edited original', 'followup']) {
			expect(
				bot.inspectChannel(channel.id).messages.find(message => message.payload.content === content)?.payload.author,
			).toMatchObject(expected);
		}
		expect(
			bot.world
				.snapshot()
				.members.filter(member => member.userId === identity.id)
				.map(member => member.guildId),
		).toEqual([first.id, second.id]);
		expect(
			bot.world
				.snapshot()
				.messages.filter(message => ['seeded', 'REST edited', 'edited original', 'followup'].includes(message.content))
				.map(message => message.authorId),
		).toEqual([identity.id, identity.id, identity.id, identity.id]);
		await bot.seed(builder => {
			const later = builder.registerGuild({ id: 'profile-later' });
			builder.registerBotMember(later.id);
		});
		expect(await bot.client.cache.members?.raw(identity.id, 'profile-later')).toMatchObject({ user: expected });
	});

	test('a profile id and legacy botId cannot disagree', async () => {
		await expect(createMockBot({ botUser: { id: 'profile-id' }, botId: 'other-id' })).rejects.toThrow(
			/conflicts with botId/,
		);
		const world = mockWorld();
		world.botUser({ id: 'world-id' });
		await expect(createMockBot({ world, botId: 'other-id' })).rejects.toThrow(/conflicts with world\.botUser/);
	});

	test('the default profile is the same for client, REST messages, and seeded members', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'default-profile-guild' });
		const channel = world.registerChannel(guild.id);
		const member = world.registerBotMember(guild.id);
		world.registerMessage(channel.id, { author: world.botUser(), content: 'seeded default' });
		await using bot = await createMockBot({ world });
		await bot.client.messages.write(channel.id, { content: 'REST default' });
		expect(bot.client.me).toMatchObject({
			id: TEST_BOT_ID,
			username: 'slipher-test-bot',
			globalName: 'Slipher Test Bot',
		});
		expect(bot.world.snapshot().botUser).toMatchObject({
			id: TEST_BOT_ID,
			username: 'slipher-test-bot',
			global_name: 'Slipher Test Bot',
			bot: true,
		});
		expect(member.user).toMatchObject({
			id: TEST_BOT_ID,
			username: 'slipher-test-bot',
			global_name: 'Slipher Test Bot',
			bot: true,
		});
		expect(bot.inspectChannel(channel.id).messages.map(message => message.payload.author.username)).toEqual([
			'slipher-test-bot',
			'slipher-test-bot',
		]);
	});

	test('setting only a username gives the bot the same display name', () => {
		const world = mockWorld();
		expect(world.botUser({ username: 'solo-bot' })).toMatchObject({ username: 'solo-bot', global_name: 'solo-bot' });
	});

	test('createMockBot accepts the same profile without a world', async () => {
		await using bot = await createMockBot({ botUser: { id: '900000000000000098', username: 'standalone-bot' } });
		expect(bot.client.me).toMatchObject({
			id: '900000000000000098',
			username: 'standalone-bot',
			globalName: 'standalone-bot',
		});
		expect(bot.world.snapshot().botUser).toMatchObject({
			id: '900000000000000098',
			username: 'standalone-bot',
			global_name: 'standalone-bot',
			bot: true,
		});
		const message = await bot.client.messages.write('standalone-channel', { content: 'hello' });
		expect(message.author).toMatchObject({
			id: '900000000000000098',
			username: 'standalone-bot',
			globalName: 'standalone-bot',
			bot: true,
		});
	});

	test('createMockBot profile updates a bot author seeded before boot', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'option-profile-guild' });
		const channel = world.registerChannel(guild.id);
		const member = world.registerBotMember(guild.id);
		const seeded = world.registerMessage(channel.id, { author: world.botUser(), content: 'before boot' });
		await using bot = await createMockBot({
			world,
			botUser: { id: '900000000000000097', username: 'option-bot', globalName: 'Option Bot' },
		});
		const expected = { id: '900000000000000097', username: 'option-bot', global_name: 'Option Bot', bot: true };
		expect(member.user).toMatchObject(expected);
		expect(seeded.author).toMatchObject(expected);
		expect(bot.inspectChannel(channel.id).messages[0]?.payload.author).toMatchObject(expected);
	});

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
		await expectDiscordError(
			bot.slash({ name: 'ban-target', guildId: guild.id, channel, user: actor.user }),
			DiscordErrors.MissingPermissions,
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
		// The types refuse this now (pinned in type-dx.test.mts), so reaching it takes a deliberate cast — and the
		// runtime guard still has to explain it, because a cast is not the only way past the types.
		world.registerMember(guild.id, { user: richUser({ id: 'fixture-user' }) as unknown as ApiUser });

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
