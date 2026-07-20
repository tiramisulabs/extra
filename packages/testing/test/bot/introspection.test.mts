import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	Declare,
	type MenuCommandContext,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { Routes } from '../../src/bot/routes';

describe('introspection helpers (DX-2)', () => {
	@Declare({ name: 'ping', description: 'Replies with pong' })
	class PingCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'pong' });
		}
	}

	class ProfileMenu extends ContextMenuCommand {
		type = ApplicationCommandType.User as const;
		name = 'profile';

		async run(ctx: MenuCommandContext<UserCommandInteraction>) {
			await ctx.write({ content: 'profile' });
		}
	}

	class ConfirmButton extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'confirm';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.write({ content: 'confirmed' });
		}
	}

	test('registeredCommands lists commands with name and derived type', async () => {
		const bot = await createMockBot({ commands: [PingCommand, ProfileMenu] });
		const found = bot.registeredCommands().flatMap(entry => entry.found);

		expect(found).toEqual(
			expect.arrayContaining([
				{ name: 'ping', type: 'chatInput' },
				{ name: 'profile', type: 'user' },
			]),
		);
		await bot.close();
	});

	test('registeredComponents lists component/modal handlers by constructor name', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });

		expect(bot.registeredComponents()).toEqual([{ name: 'ConfirmButton', kind: 'component' }]);
		await bot.close();
	});

	test('diagnostics returns recent actions after a dispatch', async () => {
		const bot = await createMockBot({ commands: [PingCommand] });
		await bot.slash({ name: 'ping' });

		const diag = bot.diagnostics();
		expect(diag.recentActions.length).toBeGreaterThan(0);
		expect(diag.recentActions.some(action => action.method === 'POST')).toBe(true);
		expect(diag.pending).toEqual([]);
		await bot.close();
	});

	test('diagnostics surfaces an un-settled (stepped but not awaited) dispatch as pending', async () => {
		const bot = await createMockBot({ commands: [PingCommand] });
		const dispatch = bot.dispatch.slash({ name: 'ping' });
		await dispatch.until(action => action.method === 'POST');

		const diag = bot.diagnostics();
		expect(diag.pending.some(entry => entry.started && !entry.settled)).toBe(true);

		await dispatch;
		await bot.close();
	});
});

describe('typed findAction (S19)', () => {
	@Declare({ name: 'say-hi', description: 'Writes a channel message' })
	class SayHiCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.messages.write('greet-channel', { content: 'hello world' });
			await ctx.write({ content: 'done' });
		}
	}

	test('findAction<TBody> exposes a typed body without a cast', async () => {
		const bot = await createMockBot({ commands: [SayHiCommand] });
		await bot.slash({ name: 'say-hi' });

		const call = bot.findAction<{ content: string }>(Routes.createMessage);
		const content: string | undefined = call?.body?.content;
		expect(content).toBe('hello world');

		// @ts-expect-error nonexistentField is not on the typed body
		const _wrong: unknown = call?.body?.nonexistentField;
		void _wrong;
		await bot.close();
	});

	test('findActions<TBody> and waitForAction<TBody> are likewise typed', async () => {
		const bot = await createMockBot({ commands: [SayHiCommand] });
		await bot.slash({ name: 'say-hi' });

		const calls = bot.findActions<{ content: string }>(Routes.createMessage);
		const first: string | undefined = calls[0]?.body?.content;
		expect(first).toBe('hello world');

		const awaited = await bot.waitForAction<{ content: string }>(Routes.createMessage);
		const awaitedContent: string | undefined = awaited.body?.content;
		expect(awaitedContent).toBe('hello world');
		await bot.close();
	});
});
