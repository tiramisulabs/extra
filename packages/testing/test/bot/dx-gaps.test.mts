import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	Embed,
} from 'seyfert';
import { ButtonStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { rendered } from '../../src';
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
	const seen: { guildId: string | undefined; channelId: string }[] = [];

	class GoButton extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'go';
		async run(ctx: ComponentContext<'Button'>) {
			seen.push({ guildId: ctx.guildId, channelId: (await ctx.channel()).id });
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

		expect(seen).toEqual([{ guildId: guild.id, channelId: channel.id }]);
		await bot.close();
	});

	test('an explicit historical source overrides the current session location', async () => {
		seen.length = 0;
		const world = mockWorld();
		const currentGuild = world.registerGuild({ id: 'current-guild' });
		const currentChannel = world.registerChannel(currentGuild.id, { id: 'current-channel' });
		const sourceGuild = world.registerGuild({ id: 'source-guild' });
		const sourceChannel = world.registerChannel(sourceGuild.id, { id: 'source-channel' });
		const bot = await createMockBot({ commands: [OpenCommand], components: [GoButton], world });

		await bot.slash({ name: 'open', guildId: currentGuild.id, channel: currentChannel });
		await bot.rest.request('POST', `/channels/${sourceChannel.id}/messages`, {
			body: {
				content: 'historical source',
				components: [
					{
						type: 1,
						components: [{ type: 2, style: 1, custom_id: 'go', label: 'Go' }],
					},
				],
			},
		});
		const source = bot.actions.at(-1);
		if (!source) throw new Error('expected historical source action');

		await bot.clickButton('go', { source });

		expect(seen).toEqual([{ guildId: sourceGuild.id, channelId: sourceChannel.id }]);
		await bot.close();
	});
});

describe('#3 + #4 await a parked collector top-to-bottom', () => {
	const events: string[] = [];
	const LaunchCommand = parkingCommand('launch', 'go', events);

	test('stateful steps park at waitFor and a source-less click resumes it', async () => {
		events.length = 0;
		const bot = await createMockBot({ commands: [LaunchCommand] });

		await bot.slash({ name: 'launch' });
		expect(events).toEqual([]); // not resumed yet

		await bot.clickButton('go');

		expect(events).toEqual(['resumed:go']);
		await bot.close();
	});

	test('a source-less click is rejected only when 2+ dispatches are in flight', async () => {
		events.length = 0;
		const LaunchA = parkingCommand('launch-a', 'btn-a', events);
		const LaunchB = parkingCommand('launch-b', 'btn-b', events);
		const bot = await createMockBot({ commands: [LaunchA, LaunchB] });

		const a = bot.dispatch.slash({ name: 'launch-a' });
		const b = bot.dispatch.slash({ name: 'launch-b' });
		const aReply = await a.untilComponent('btn-a');
		const bReply = await b.untilComponent('btn-b');

		// two parked dispatches -> "the most recent message" is a genuine race -> fail loud (thrown synchronously)
		expect(() => bot.dispatch.clickButton('btn-a')).toThrow(/2 dispatches are still running/);

		// an explicit source disambiguates and settles each opener
		await bot.dispatch.clickButton('btn-a', { source: aReply });
		await bot.dispatch.clickButton('btn-b', { source: bReply });
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

describe('#4 regression: defer -> non-REST gap -> render collector button', () => {
	const events: string[] = [];

	// The shape that broke on the REST-quiescence drain: a non-REST await (a DB query) sits between deferReply and
	// the reply that renders "confirm", so the button lands well after REST first goes quiet.
	@Declare({ name: 'reopen', description: 'defers, awaits non-REST work, then renders a confirm button' })
	class ReopenCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.deferReply();
			await new Promise<void>(resolve => setTimeout(resolve, 40)); // non-REST gap (stands in for a DB query)
			const row = new ActionRow<Button>().setComponents([
				new Button().setCustomId('confirm').setLabel('Confirm').setStyle(ButtonStyle.Primary),
			]);
			const message = await ctx.editOrReply({ content: 'Reopen?', components: [row] }, true);
			const interaction = await message.createComponentCollector().waitFor('confirm', 20_000);
			if (interaction) {
				events.push('confirmed');
				await interaction.write({ content: 'reopened' });
			}
		}
	}

	test('the stateful slash waits across the non-REST gap, then a source-less click drives it', async () => {
		events.length = 0;
		const bot = await createMockBot({ commands: [ReopenCommand] });

		await bot.slash({ name: 'reopen' });
		expect(events).toEqual([]);

		await bot.clickButton('confirm');

		expect(events).toEqual(['confirmed']);
		await bot.close();
	});

	test('the source-based click hatch also drives the parked collector', async () => {
		events.length = 0;
		const bot = await createMockBot({ commands: [ReopenCommand] });

		const flow = bot.dispatch.slash({ name: 'reopen' });
		const reply = await flow.untilComponent('confirm');
		await bot.clickButton('confirm', { source: reply });
		await flow;

		expect(events).toEqual(['confirmed']);
		await bot.close();
	});
});

describe('more click/flow DX', () => {
	test('clickButton auto-synthesizes a source for a registered ComponentCommand (incl. filter/dynamic customId), no flag', async () => {
		const clicked: string[] = [];
		class SubmitButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId.startsWith('submit:auto:'); // dynamic customId via filter, no static customId
			}
			async run(ctx: ComponentContext<'Button'>) {
				clicked.push(ctx.customId);
				await ctx.write({ content: 'ok' });
			}
		}

		const bot = await createMockBot({ components: [SubmitButton] });
		const res = await bot.clickButton('submit:auto:c1'); // no source, no allowSyntheticSource — auto-synthesized
		expect(clicked).toEqual(['submit:auto:c1']);
		expect(res.content).toBe('ok');
		await bot.close();
	});

	test('slash/clickButton accept a userId shorthand (mirrors mockComponentContext)', async () => {
		const seen: (string | undefined)[] = [];
		@Declare({ name: 'who', description: 'reports the caller' })
		class WhoCommand extends Command {
			async run(ctx: CommandContext) {
				seen.push(ctx.author.id);
				await ctx.write({ content: ctx.author.id });
			}
		}

		const bot = await createMockBot({ commands: [WhoCommand] });
		await bot.slash({ name: 'who', userId: '99' });
		expect(seen).toEqual(['99']);
		await bot.close();
	});

	test('a parked flow exposes what it already rendered through rendered(flow)', async () => {
		const events: string[] = [];
		@Declare({ name: 'launch', description: 'replies then waits' })
		class LaunchCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.deferReply();
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('go').setLabel('Go').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.editOrReply(
					{ content: 'Ready?', embeds: [new Embed().setTitle('Launch')], components: [row] },
					true,
				);
				const interaction = await message.createComponentCollector().waitFor('go', 30_000);
				if (interaction) events.push('clicked');
			}
		}

		const bot = await createMockBot({ commands: [LaunchCommand] });
		const flow = bot.dispatch.slash({ name: 'launch' });
		const source = await flow.untilComponent('go'); // parked on waitFor

		// assert what the parked (not-yet-settled) flow already rendered:
		expect(flow.lastEmbed().title).toBe('Launch');
		expect(flow.lastComponents().map(component => component.customId)).toContain('go');
		rendered(flow).get.button('go');
		rendered(flow).get.embed({ title: 'Launch' });

		await bot.dispatch.clickButton('go', { source });
		await flow;
		expect(events).toEqual(['clicked']);
		await bot.close();
	});

	test('untilComponent error names what was rendered instead', async () => {
		@Declare({ name: 'reject', description: 'renders a rejection then settles' })
		class RejectCommand extends Command {
			async run(ctx: CommandContext) {
				await ctx.editOrReply({ embeds: [new Embed().setTitle('Not allowed')] }, true);
			}
		}

		const bot = await createMockBot({ commands: [RejectCommand] });
		const flow = bot.dispatch.slash({ name: 'reject' });
		await expect(flow.untilComponent('confirm-menu')).rejects.toThrow(/Not allowed/);
		await bot.close();
	});
});
