import { ActionRow, Button, Command, type CommandContext, Declare, Embed, Middlewares } from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
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
	test('worldChannel/worldRole resolve by id alone and the role view keeps permissions/color', async () => {
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

		expect(bot.worldChannel(channel.id)?.name).toBe('general');
		expect(bot.worldChannel('missing')).toBeUndefined();

		const view = bot.worldRole(role.id);
		expect(view?.name).toBe('mods');
		expect(view?.position).toBe(3);
		expect(BigInt(view?.permissions ?? '0') & 4n).toBe(4n);

		expect(bot.worldGuild(guild.id)?.role(role.id)?.permissions).toBe(view?.permissions);
		await bot.close();
	});

	test('worldVoiceState delegates to the state reader', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'dx-vc-guild' });
		const channel = world.registerChannel(guild.id, { type: 2 });
		world.registerMember(guild.id, { user: apiUser({ id: 'dx-vc-user' }) });
		world.registerVoiceState(guild.id, { userId: 'dx-vc-user', channelId: channel.id });
		const bot = await createMockBot({ commands: [GreetCommand], world });

		expect(bot.worldVoiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.world.voiceState(guild.id, 'dx-vc-user')?.channel_id).toBe(channel.id);
		expect(bot.worldVoiceState(guild.id, 'absent')).toBeUndefined();
		await bot.close();
	});
});

@Declare({ name: 'panel', description: 'Replies with an embed and a button' })
class PanelCommand extends Command {
	async run(ctx: CommandContext) {
		const embed = new Embed().setTitle('Profile').setDescription('Level 7');
		const row = new ActionRow<Button>().setComponents([
			new Button().setCustomId('approve').setLabel('Approve').setStyle(ButtonStyle.Success),
		]);
		await ctx.write({ embeds: [embed], components: [row] });
	}
}

describe('F34 typed DispatchResult accessors', () => {
	test('embedView and component(...) read parsed views without casts', async () => {
		const bot = await createMockBot({ commands: [PanelCommand] });
		const result = await bot.slash({ name: 'panel' });

		// embedView is typed EmbedView — no `as APIEmbed`.
		expect(result.embedView?.title).toBe('Profile');
		expect(result.embedView?.description).toBe('Level 7');
		expect(result.embedViews).toHaveLength(1);

		expect(result.components.map(view => view.customId)).toEqual(['approve']);
		expect(result.component('Approve')?.customId).toBe('approve');
		expect(result.component('approve')?.label).toBe('Approve');
		expect(result.component('missing')).toBeUndefined();
		await bot.close();
	});
});
