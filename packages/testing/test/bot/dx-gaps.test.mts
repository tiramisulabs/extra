import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
} from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { mockWorld } from '../../src/bot/world';

// A slash that replies with one button, then blocks on `collector.waitFor(...)` until the button is clicked —
// the real "open a control, await the user" shape. `events` records when the post-waitFor continuation runs.
function parkingCommand(name: string, buttonId: string, events: string[]): typeof Command {
	@Declare({ name, description: 'replies with a button then awaits a click' })
	class Parking extends Command {
		async run(ctx: CommandContext) {
			await ctx.deferReply();
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId(buttonId).setLabel('Go').setStyle(ButtonStyle.Primary),
			]);
			const message = await ctx.editOrReply({ content: 'ready', components: [row] }, true);
			const interaction = await message.createComponentCollector().waitFor(buttonId, 30_000);
			if (interaction) {
				events.push(`resumed:${buttonId}`);
				await interaction.write({ content: `done:${buttonId}` });
			}
		}
	}
	return Parking;
}

describe('#5 Dispatch is promise-like (.catch / .finally)', () => {
	@Declare({ name: 'ping', description: 'replies pong' })
	class PingCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'pong' });
		}
	}

	test('.finally runs and resolves to the dispatch result', async () => {
		const bot = await createMockBot({ commands: [PingCommand] });
		let ranFinally = false;
		const res = await bot.slash({ name: 'ping' }).finally(() => {
			ranFinally = true;
		});
		expect(ranFinally).toBe(true);
		expect(res.content).toBe('pong');
		await bot.close();
	});

	test('.catch is callable and passes the value through on success', async () => {
		const bot = await createMockBot({ commands: [PingCommand] });
		const res = await bot.slash({ name: 'ping' }).catch(() => null);
		expect(res?.content).toBe('pong');
		await bot.close();
	});
});

describe('#2 component inherits guildId from the source message', () => {
	const seen: (string | undefined)[] = [];

	class GoButton extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'go';
		async run(ctx: ComponentContext<'Button'>) {
			seen.push(ctx.guildId);
			await ctx.write({ content: 'ok' });
		}
	}

	@Declare({ name: 'open', description: 'sends a button' })
	class OpenCommand extends Command {
		async run(ctx: CommandContext) {
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('go').setLabel('Go').setStyle(ButtonStyle.Primary),
			]);
			await ctx.write({ content: 'pick', components: [row] });
		}
	}

	test('a click on a reply from guild G dispatches with guild_id G, not the default', async () => {
		seen.length = 0;
		const world = mockWorld();
		const guild = world.registerGuild({ id: '111111111111111111' });
		const channel = world.registerChannel(guild.id, { id: '222222222222222222' });
		const bot = await createMockBot({ commands: [OpenCommand], components: [GoButton], world });

		await bot.slash({ name: 'open', guildId: guild.id, channel });
		await bot.clickButton('go');

		expect(seen).toEqual([guild.id]);
		await bot.close();
	});
});

describe('#3 + #4 await a parked collector top-to-bottom', () => {
	const events: string[] = [];
	const LaunchCommand = parkingCommand('launch', 'go', events);

	test('untilComponent parks at waitFor and a source-less click resumes it', async () => {
		events.length = 0;
		const bot = await createMockBot({ commands: [LaunchCommand] });

		const flow = bot.slash({ name: 'launch' });
		await flow.untilComponent('go'); // started, reply+button rendered, handler parked on waitFor
		expect(events).toEqual([]); // not resumed yet

		await bot.clickButton('go'); // #3: source-less click works with exactly one dispatch in flight
		await flow; // handler resumes past waitFor and returns

		expect(events).toEqual(['resumed:go']);
		await bot.close();
	});

	test('a source-less click is rejected only when 2+ dispatches are in flight', async () => {
		events.length = 0;
		const LaunchA = parkingCommand('launch-a', 'btn-a', events);
		const LaunchB = parkingCommand('launch-b', 'btn-b', events);
		const bot = await createMockBot({ commands: [LaunchA, LaunchB] });

		const a = bot.slash({ name: 'launch-a' });
		const b = bot.slash({ name: 'launch-b' });
		const aReply = await a.untilComponent('btn-a');
		const bReply = await b.untilComponent('btn-b');

		// two parked dispatches -> "the most recent message" is a genuine race -> fail loud (thrown synchronously)
		expect(() => bot.clickButton('btn-a')).toThrow(/2 dispatches are still running/);

		// an explicit source disambiguates and settles each opener
		await bot.clickButton('btn-a', { source: aReply });
		await bot.clickButton('btn-b', { source: bReply });
		await a;
		await b;

		expect(events.sort()).toEqual(['resumed:btn-a', 'resumed:btn-b']);
		await bot.close();
	});
});

describe('#6 bot.settle() drains detached background work', () => {
	@Declare({ name: 'bg', description: 'replies then writes in the background' })
	class BgCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'started' });
			// fire-and-forget: a follow-up REST call the handler does NOT await before returning
			void new Promise<void>(resolve => setImmediate(resolve)).then(() =>
				ctx.client.messages.write('900000000000000010', { content: 'background' }),
			);
		}
	}

	test('background REST after the reply settles only after bot.settle()', async () => {
		const bot = await createMockBot({ commands: [BgCommand] });

		await bot.slash({ name: 'bg' });
		expect(bot.created('message', { content: 'background' })).toHaveLength(0); // still detached

		await bot.settle();
		expect(bot.created('message', { content: 'background' })).toHaveLength(1); // drained

		await bot.close();
	});
});

describe('#8 bot.created() semantic query', () => {
	@Declare({ name: 'mkrole', description: 'creates a role' })
	class MkRoleCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.client.roles.create('111111111111111111', { name: 'VIP' });
			await ctx.write({ content: 'made' });
		}
	}

	test('created(resource, match?) finds entity-create calls and filters by body', async () => {
		const world = mockWorld();
		world.registerGuild({ id: '111111111111111111' });
		const bot = await createMockBot({ commands: [MkRoleCommand], world });

		await bot.slash({ name: 'mkrole', guildId: '111111111111111111' });

		expect(bot.created('role')).toHaveLength(1);
		expect(bot.created('role', { name: 'VIP' })).toHaveLength(1);
		expect(bot.created('role', { name: 'NOPE' })).toHaveLength(0);
		expect(bot.created('channel')).toHaveLength(0);
		expect(bot.created('role')[0].body).toMatchObject({ name: 'VIP' });
		await bot.close();
	});
});
