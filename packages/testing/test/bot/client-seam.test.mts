import { Client, Command, type CommandContext, createPlugin, Declare } from 'seyfert';
import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

// Mirrors a production bot's module-level `export let client` singleton (e.g. a `start.ts` export):
// commands reach Discord REST through THIS variable, not through ctx.client.
let client: Client;

@Declare({ name: 'announce', description: 'Sends a message through the module-level client singleton' })
class AnnounceCommand extends Command {
	async run(ctx: CommandContext) {
		await client.messages.write('123456789012345678', { content: 'broadcast' });
		await ctx.write({ content: 'sent' });
	}
}

describe('createMockBot({ client })', () => {
	test('instruments a provided client so its module-level singleton REST is captured', async () => {
		client = new Client();
		const bot = await createMockBot({ client, commands: [AnnounceCommand] });

		// the singleton and the dispatchers drive the same instrumented client
		expect(client).toBe(bot.client);

		const res = await bot.slash({ name: 'announce' });
		expect(res.content).toBe('sent');

		// REST issued through the singleton (not ctx) was captured by the mock
		const call = bot.findAction({ method: 'POST', route: '/channels/:channelId/messages' });
		expect(call).toBeTruthy();
		expect(call?.body).toMatchObject({ content: 'broadcast' });

		await bot.close();
	});

	test('uses plugins already resolved on a provided client without warning', async () => {
		const state = { setupRan: false };
		const plugin = createPlugin({
			name: 'client-owned-plugin',
			setup() {
				state.setupRan = true;
			},
		});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		client = new Client({ plugins: [plugin] });

		const bot = await createMockBot({ client });

		expect(state.setupRan).toBe(true);
		expect(warn.mock.calls.flat().some(message => String(message).includes('createMockBot({ client, plugins })'))).toBe(
			false,
		);
		await bot.close();
		warn.mockRestore();
	});

	test('warns when plugins are passed alongside an already-constructed client', async () => {
		const plugin = createPlugin({ name: 'ignored-client-plugin' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		client = new Client();

		const bot = await createMockBot({ client, plugins: [plugin] });

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('createMockBot({ client, plugins }) ignores'));
		expect(bot.plugins.map(info => info.name)).not.toContain('ignored-client-plugin');
		await bot.close();
		warn.mockRestore();
	});
});
