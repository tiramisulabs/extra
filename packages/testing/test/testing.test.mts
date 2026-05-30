import { assert, describe, test } from 'vitest';
import {
	mockChannel,
	mockCommandContext,
	mockGuild,
	mockMember,
	mockQueues,
	mockScheduler,
	mockUser,
	resetMockIds,
} from '../src';

describe('entity factories', () => {
	test('generate unique IDs by default', () => {
		resetMockIds();

		const first = mockUser();
		const second = mockUser();
		const guild = mockGuild();
		const channel = mockChannel();

		assert.notEqual(first.id, second.id);
		assert.notEqual(first.id, guild.id);
		assert.notEqual(guild.id, channel.id);
	});

	test('preserve explicit overrides', () => {
		const user = mockUser({ id: '1', username: 'socram', bot: true });
		const guild = mockGuild({ id: '2', name: 'Seyfert' });
		const channel = mockChannel({ id: '3', guildId: null });
		const member = mockMember({ user, roles: ['admin'], nick: 'Soc' });

		assert.equal(user.id, '1');
		assert.equal(user.username, 'socram');
		assert.equal(user.bot, true);
		assert.equal(guild.name, 'Seyfert');
		assert.equal(channel.guildId, null);
		assert.deepEqual(member.roles, ['admin']);
		assert.equal(member.nick, 'Soc');
	});

	test('preserve an explicit null globalName', () => {
		const user = mockUser({ username: 'socram', globalName: null });

		assert.equal(user.globalName, null);
	});

	test('reject non-integer mock ID reset values before conversion', () => {
		assert.throws(() => resetMockIds(1.5), TypeError);
		assert.throws(() => resetMockIds('1.5'), TypeError);
		assert.throws(() => resetMockIds('abc'), TypeError);

		resetMockIds(' 42 ');

		assert.equal(mockUser().id, '42');
	});
});

describe('mockCommandContext', () => {
	test('captures responses in call order', async () => {
		const ctx = mockCommandContext({ commandName: 'ping', userId: '1', guildId: '2', channelId: '3' });

		await ctx.write({ content: 'pong' });
		await ctx.editOrReply({ content: 'edited' });
		await ctx.followup('done');

		assert.equal(ctx.command.name, 'ping');
		assert.equal(ctx.author.id, '1');
		assert.equal(ctx.guildId, '2');
		assert.equal(ctx.channelId, '3');
		assert.deepEqual(ctx.responses, [{ content: 'pong' }, { content: 'edited' }, 'done']);
		assert.equal(ctx.lastResponse(), 'done');
	});

	test('clears captured responses without depending on runner spies', async () => {
		const ctx = mockCommandContext();

		await ctx.write('hello');
		ctx.clearResponses();

		assert.deepEqual(ctx.responses, []);
		assert.equal(ctx.lastResponse(), undefined);
	});

	test('creates direct-message-like contexts without impossible guild state', () => {
		const member = mockMember();
		const ctx = mockCommandContext({ guild: null, guildId: '2', member });

		assert.equal(ctx.guild, null);
		assert.equal(ctx.guildId, undefined);
		assert.equal(ctx.member, null);
		assert.equal(ctx.channel.guildId, null);
	});

	test('provides integration stubs for logger, queues, and scheduler', async () => {
		const ctx = mockCommandContext();

		ctx.logger.add({ command: 'ping' });
		ctx.logger.info('ran');
		await ctx.queues.get('welcome').add({ userId: ctx.author.id }, { delay: '5s' });
		ctx.scheduler.add('reminder', '30m', () => undefined);

		assert.deepEqual(ctx.logger.entries.at(-1), { level: 'info', args: ['ran'] });
		assert.deepEqual(ctx.queues.get('welcome').jobs.at(-1)?.payload, { userId: ctx.author.id });
		assert.equal(ctx.scheduler.tasks.at(-1)?.name, 'reminder');
	});
});

describe('standalone stubs', () => {
	test('mockQueues returns stable named queues', async () => {
		const queues = mockQueues();
		const first = queues.get('email');
		const second = queues.get('email');

		await first.add({ to: 'a@example.com' });

		assert.equal(first, second);
		assert.equal(second.jobs.length, 1);
	});

	test('mockScheduler records dynamic tasks', () => {
		const scheduler = mockScheduler();
		const task = scheduler.add('heartbeat', '5m', () => undefined);

		assert.equal(task.name, 'heartbeat');
		assert.equal(scheduler.tasks.length, 1);
	});
});
