import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { AUDIT_ACTION, Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';

/** The precondition-already-holds seed: guild, a target member, and an admin bot member. */
function moderationFixture(tag: string) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: `${tag}-guild` });
	const botRole = world.registerRole(guild.id, { id: `${tag}-bot-role`, permissions: '8', position: 10 });
	world.registerBotMember(guild.id, { roles: [botRole.id] });
	const channel = world.registerChannel(guild.id, { id: `${tag}-chan` });
	const actor = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-actor` }) });
	return { world, guild, channel, actor };
}

describe('seeding the families the mock otherwise only derives', () => {
	test('a ban can hold before the test starts, with no REST call to skip past', async () => {
		const { world, guild } = moderationFixture('seed-ban');
		world.registerBan(guild.id, { userId: 'already-banned', reason: 'raid wave 1' });

		const bot = await createMockBot({ world });

		expect(bot.world.query.ban({ guildId: guild.id, userId: 'already-banned' })).toMatchObject({
			userId: 'already-banned',
			reason: 'raid wave 1',
		});
		// the point of seeding: the journal is clean, so an assertion about the test's OWN bans is unambiguous
		expect(bot.restCalls(Routes.ban)).toHaveLength(0);
		await bot.close();
	});

	test('a pin, a reaction, a thread membership and a poll vote all seed', async () => {
		const { world, channel, actor } = moderationFixture('seed-derived');
		const message = world.registerMessage(channel.id, { id: 'seeded-message', content: 'vote here' });
		const thread = world.registerThread(channel.id, { id: 'seeded-thread' });
		world.registerPin(channel.id, message.id);
		world.registerReaction(channel.id, message.id, { emoji: '👍', userId: actor.user.id });
		world.registerThreadMember(thread.id, actor.user.id);
		world.registerPollVote(channel.id, message.id, { answerId: 1, userId: actor.user.id });

		const bot = await createMockBot({ world });

		expect(bot.world.query.pin({ channelId: channel.id, messageId: message.id })).toBeDefined();
		expect(bot.world.query.channel({ id: channel.id })?.pins.map(pin => pin.id)).toEqual([message.id]);
		expect(bot.world.query.message({ channelId: channel.id, id: message.id })?.reaction('👍')?.users).toContain(
			actor.user.id,
		);
		expect(bot.world.query.threadMember({ channelId: thread.id, userId: actor.user.id })).toBeDefined();
		expect(bot.world.query.pollVote({ channelId: channel.id, messageId: message.id, answerId: 1 })).toBeDefined();
		await bot.close();
	});

	test('a pin needs a message to point at, and says so', () => {
		const { world, channel } = moderationFixture('seed-orphan');
		expect(() => world.registerPin(channel.id, 'ghost-message')).toThrow(/no message "ghost-message"/);
	});

	test('seeding twice does not duplicate', async () => {
		const { world, guild, channel } = moderationFixture('seed-idem');
		const message = world.registerMessage(channel.id, { id: 'idem-message' });
		world.registerBan(guild.id, { userId: 'twice' });
		world.registerBan(guild.id, { userId: 'twice' });
		world.registerPin(channel.id, message.id);
		world.registerPin(channel.id, message.id);

		const bot = await createMockBot({ world });

		expect(bot.world.all.ban({ guildId: guild.id })).toHaveLength(1);
		expect(bot.world.query.channel({ id: channel.id })?.pins).toHaveLength(1);
		await bot.close();
	});
});

describe('moderation writes the audit log the way Discord does', () => {
	test('a ban with a reason lands in the audit log and on the ban itself', async () => {
		const { world, guild, actor } = moderationFixture('audit-ban');

		const bot = await createMockBot({ world });
		await bot.client.bans.create(guild.id, actor.user.id, { reason: 'spamming invites' });

		expect(bot.world.query.ban({ guildId: guild.id, userId: actor.user.id })).toMatchObject({
			reason: 'spamming invites',
		});
		expect(bot.world.all.auditLogEntry({ guildId: guild.id })).toMatchObject([
			{ action_type: AUDIT_ACTION.memberBanAdd, target_id: actor.user.id, reason: 'spamming invites' },
		]);
		await bot.close();
	});

	test('kick and unban record their own action types', async () => {
		const { world, guild, actor } = moderationFixture('audit-kick');
		const second = world.registerMember(guild.id, { user: apiUser({ id: 'audit-kick-second' }) });

		const bot = await createMockBot({ world });
		await bot.client.members.kick(guild.id, actor.user.id, 'inactive');
		await bot.client.bans.create(guild.id, second.user.id, { reason: 'raid' });
		await bot.client.bans.remove(guild.id, second.user.id, 'appealed');

		expect(bot.world.all.auditLogEntry({ guildId: guild.id }).map(entry => entry.action_type)).toEqual([
			AUDIT_ACTION.memberKick,
			AUDIT_ACTION.memberBanAdd,
			AUDIT_ACTION.memberBanRemove,
		]);
		await bot.close();
	});

	test('the audit trail is diffable, like every other family', async () => {
		const { world, guild, actor } = moderationFixture('audit-diff');

		const bot = await createMockBot({ world });
		const before = bot.world.snapshot();
		await bot.client.bans.create(guild.id, actor.user.id, { reason: 'why' });

		const diff = bot.world.diff(before);
		expect(diff.auditLogEntries.added).toMatchObject([{ actionType: AUDIT_ACTION.memberBanAdd, reason: 'why' }]);
		expect(diff.bans.added).toMatchObject([{ userId: actor.user.id, reason: 'why' }]);
		await bot.close();
	});
});

describe('diff covers every family the readers expose', () => {
	test('the five families that had readers and registrars but no bucket now diff', async () => {
		const { world, guild, channel } = moderationFixture('diff-cover');

		const bot = await createMockBot({ world });
		const before = bot.world.snapshot();

		await bot.seed(w => {
			w.registerGuild({ id: 'late-guild' });
			w.registerAuditLogEntry(guild.id, { id: 'late-log', actionType: 1 });
			w.registerStageInstance(channel.id, { topic: 'late stage' });
			w.registerGuildTemplate(guild.id, { code: 'late-code', name: 'late template' });
			w.registerSoundboardSound(guild.id, { soundId: 'late-sound', name: 'late' });
		});

		const diff = bot.world.diff(before);
		expect(diff.guilds.added.map(entry => entry.id)).toEqual(['late-guild']);
		expect(diff.auditLogEntries.added.map(entry => entry.id)).toEqual(['late-log']);
		expect(diff.stageInstances.added.map(entry => entry.topic)).toEqual(['late stage']);
		expect(diff.guildTemplates.added.map(entry => entry.code)).toEqual(['late-code']);
		expect(diff.soundboardSounds.added.map(entry => entry.id)).toEqual(['late-sound']);
		await bot.close();
	});

	test('every queryable family has a diff bucket', () => {
		// the finding this pins: Object.keys(diff) read as exhaustive while covering 16 of 24
		const expected = [
			'members',
			'channels',
			'messages',
			'roles',
			'bans',
			'emojis',
			'invites',
			'autoModRules',
			'stickers',
			'scheduledEvents',
			'webhooks',
			'pins',
			'reactions',
			'voiceStates',
			'threadMembers',
			'pollVoters',
			'guilds',
			'auditLogEntries',
			'stageInstances',
			'guildTemplates',
			'soundboardSounds',
		];
		const world = mockWorld();
		world.registerGuild({ id: 'shape-guild' });
		return createMockBot({ world }).then(async bot => {
			expect(Object.keys(bot.world.diff(bot.world.snapshot())).sort()).toEqual(expected.sort());
			await bot.close();
		});
	});
});
