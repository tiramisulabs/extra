import { assert, describe, test } from 'vitest';
import {
	createMockChannel,
	createMockCommandContext,
	createMockGuild,
	createMockMember,
	createMockUser,
	createRecorder,
	expectCallCount,
	FakeClock,
	getLastCall,
	getLastResponse,
} from '../src';

describe('createRecorder', () => {
	test('records calls and supports return values', async () => {
		const recorder = createRecorder<[string, number], string>().returns('ok');

		const result = await recorder('hello', 1);

		assert.equal(result, 'ok');
		assert.equal(recorder.callCount, 1);
		assert.deepEqual(recorder.lastCall, ['hello', 1]);
		assert.deepEqual(getLastCall(recorder), ['hello', 1]);
	});

	test('can clear calls and replace implementations', async () => {
		const recorder = createRecorder<[number], number>(value => value + 1);

		assert.equal(await recorder(1), 2);
		recorder.clear();
		recorder.mockImplementation(value => value + 2);

		assert.equal(recorder.callCount, 0);
		assert.equal(await recorder(1), 3);
	});
});

describe('factories', () => {
	test('creates overrideable Discord-like structures', () => {
		const user = createMockUser({ id: '1', username: 'drylozu' });
		const guild = createMockGuild({ id: '2', name: 'Seyfert' });

		assert.equal(user.id, '1');
		assert.equal(user.username, 'drylozu');
		assert.equal(guild.id, '2');
		assert.equal(guild.name, 'Seyfert');
	});
});

describe('createMockCommandContext', () => {
	test('records write, edit, and followup responses in order', async () => {
		const ctx = createMockCommandContext({ commandName: 'ping', userId: '1', guildId: '2', channelId: '3' });

		await ctx.write({ content: 'pong' });
		await ctx.editOrReply({ content: 'edited' });
		await ctx.followup('done');

		assert.equal(ctx.command.name, 'ping');
		assert.equal(ctx.author.id, '1');
		assert.equal(ctx.guildId, '2');
		assert.equal(ctx.channelId, '3');
		assert.equal(ctx.responses.length, 3);
		assert.equal(getLastResponse(ctx), 'done');
		expectCallCount(ctx.write, 1);
		expectCallCount(ctx.editOrReply, 1);
		expectCallCount(ctx.followup, 1);
	});

	test('can clear recorded responses', async () => {
		const ctx = createMockCommandContext();

		await ctx.write('hello');
		ctx.clearResponses();

		assert.equal(ctx.responses.length, 0);
		assert.equal(ctx.write.callCount, 0);
	});

	test('can create direct-message-like contexts', () => {
		const member = createMockMember();
		const ctx = createMockCommandContext({ guild: null, guildId: '2', member });

		assert.equal(ctx.guild, null);
		assert.equal(ctx.guildId, undefined);
		assert.equal(ctx.member, null);
		assert.equal(ctx.channel.guildId, null);
	});

	test('preserves explicit null guild IDs for DM channels', () => {
		const channel = createMockChannel({ guildId: null });

		assert.equal(channel.guildId, null);
	});
});

describe('FakeClock', () => {
	test('tracks deterministic time', () => {
		const clock = new FakeClock(1000);

		clock.advanceSeconds(2).advance(500);

		assert.equal(clock.now(), 3500);
		assert.equal(clock.date().getTime(), 3500);
		assert.equal(clock.set(new Date(10)).now(), 10);
	});
});
