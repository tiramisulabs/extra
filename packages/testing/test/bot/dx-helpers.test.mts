import { Command, type CommandContext, Declare, Middlewares } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { expectDenied, expectError, expectReply, MockAssertionError } from '../../src/bot/assertions';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { GreetCommand, testMiddlewares } from './_setup';

@Declare({ name: 'silent', description: 'Returns without replying' })
class SilentCommand extends Command {
	async run(_ctx: CommandContext) {}
}

@Declare({ name: 'boom', description: 'Throws an unhandled error' })
class BoomCommand extends Command {
	async run(_ctx: CommandContext) {
		throw new Error('kaboom');
	}
}

@Declare({ name: 'blocked', description: 'Denied by a middleware that stops the chain' })
@Middlewares(['blocker'])
class BlockedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'never' });
	}
}

describe('F43 assertion helpers (runner-agnostic)', () => {
	test('expectReply passes when a reply was sent and throws when none was', async () => {
		const bot = await createMockBot({ commands: [GreetCommand, SilentCommand] });
		const replied = await bot.slash({ name: 'greet', options: { name: 'x' } });
		expect(() => expectReply(replied)).not.toThrow();
		expect(expectReply(replied)).toBe(replied);

		const silent = await bot.slash({ name: 'silent' });
		expect(() => expectReply(silent)).toThrow(MockAssertionError);
		await bot.close();
	});

	test('expectDenied asserts denial and its structured kind', async () => {
		const bot = await createMockBot({ commands: [BlockedCommand], middlewares: testMiddlewares });
		const result = await bot.slash({ name: 'blocked' });
		expect(() => expectDenied(result)).not.toThrow();
		expect(() => expectDenied(result, { kind: 'stop' })).not.toThrow();
		expect(() => expectDenied(result, { kind: 'permissions' })).toThrow(MockAssertionError);
		await bot.close();
	});

	test('expectDenied throws when the dispatch actually replied', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'x' } });
		expect(() => expectDenied(result)).toThrow(MockAssertionError);
		await bot.close();
	});

	test('expectError returns the captured error and matches its message', async () => {
		const bot = await createMockBot({ commands: [BoomCommand], onCommandError: 'capture' });
		const result = await bot.slash({ name: 'boom' });
		const error = expectError(result);
		expect((error as Error).message).toBe('kaboom');
		expect(() => expectError(result, 'kaboom')).not.toThrow();
		expect(() => expectError(result, /kab/)).not.toThrow();
		expect(() => expectError(result, 'nope')).toThrow(MockAssertionError);
		await bot.close();
	});

	test('expectError throws when nothing errored', async () => {
		const bot = await createMockBot({ commands: [GreetCommand], onCommandError: 'capture' });
		const result = await bot.slash({ name: 'greet', options: { name: 'x' } });
		expect(() => expectError(result)).toThrow(MockAssertionError);
		await bot.close();
	});
});

describe('F37 symmetric readers', () => {
	test('cachedChannel/cachedRole resolve by id alone and the role view keeps permissions/color', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-guild' });
		const channel = world.registerChannel(guild.id, { name: 'general' });
		const role = world.registerRole(guild.id, {
			id: 'dx-role',
			name: 'mods',
			permissions: ['BanMembers'],
			position: 3,
		});
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-user' }) });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.cachedChannel(channel.id)?.name).toBe('general');
		expect(bot.cachedChannel('missing')).toBeUndefined();

		const view = bot.cachedRole(role.id);
		expect(view?.name).toBe('mods');
		expect(view?.position).toBe(3);
		expect(BigInt(view?.permissions ?? '0') & 4n).toBe(4n);

		expect(bot.cachedGuild(guild.id)?.role(role.id)?.permissions).toBe(view?.permissions);
		await bot.close();
	});

	test('cachedVoiceState delegates to the state reader', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-vc-guild' });
		const channel = world.registerChannel(guild.id, { type: 2 });
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-vc-user' }) });
		world.registerVoiceState(guild.id, { userId: 'dx-vc-user', channelId: channel.id });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.cachedVoiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.state.voiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.cachedVoiceState(guild.id, 'absent')).toBeUndefined();
		await bot.close();
	});
});
