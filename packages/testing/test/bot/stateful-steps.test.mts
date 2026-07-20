import { ActionRow, Button, Command, type CommandContext, Declare, Label, Modal, TextInput } from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, rendered } from '../../src';
import { apiChannel, apiUser } from '../../src/bot/payloads';

describe('stateful interaction steps', () => {
	test('drives slash -> modal -> summary button -> completion from the bot state', async () => {
		const events: string[] = [];

		@Declare({ name: 'campaign', description: 'Configure a campaign' })
		class CampaignCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('dual-cpm-modal')
						.setTitle('Campaign')
						.setComponents([
							new Label().setLabel('Client budget').setComponent(
								new TextInput({
									custom_id: 'client-budget',
									style: TextInputStyle.Short,
								}),
							),
						]),
					{ waitFor: 30_000 },
				);
				if (!submit) return;

				events.push(`budget:${submit.getInputValue('client-budget')}`);
				events.push(`modal-context:${submit.guildId}:${submit.channel.id}`);
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('dual-cpm-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const summary = await submit.editOrReply({ content: 'Review campaign', components: [row] }, true);
				const confirmation = await summary.createComponentCollector().waitFor('dual-cpm-continue');
				if (!confirmation) return;

				events.push(`click-context:${confirmation.guildId}:${confirmation.channel.id}`);
				events.push('created');
				await confirmation.write({
					content: 'Campaign created successfully',
					components: [],
				});
			}
		}

		const bot = await createMockBot({ commands: [CampaignCommand] });
		const guildId = 'campaign-guild';
		const channel = apiChannel({ id: 'campaign-channel', guildId });

		await bot.slash({ name: 'campaign', guildId, channel });
		rendered(bot).get.modal('dual-cpm-modal');

		await bot.submitModal('dual-cpm-modal', {
			'client-budget': '1000',
		});
		expect(rendered(bot).query.modal('dual-cpm-modal')).toBeUndefined();
		rendered(bot).get.button('dual-cpm-continue');
		expect(events).toEqual(['budget:1000', `modal-context:${guildId}:${channel.id}`]);

		await bot.clickButton('dual-cpm-continue');
		expect(rendered(bot).query.button('dual-cpm-continue')).toBeUndefined();
		rendered(bot).get.message({ content: /Campaign created successfully/ });
		expect(events).toEqual([
			'budget:1000',
			`modal-context:${guildId}:${channel.id}`,
			`click-context:${guildId}:${channel.id}`,
			'created',
		]);
		expect(bot.actions.length).toBeGreaterThan(bot.currentActions.length);
		await expect(bot.clickButton('dual-cpm-continue')).rejects.toThrow(/does not contain a component/);

		await bot.close();
	});

	test('does not yield merely because a button rendered before the handler finished', async () => {
		let release!: () => void;
		const paused = new Promise<void>(resolve => {
			release = resolve;
		});
		let resolved = false;

		@Declare({ name: 'slow-panel', description: 'Render before finishing non-input work' })
		class SlowPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('eventual').setLabel('Eventual').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'rendered early', components: [row] });
				await paused;
			}
		}

		const bot = await createMockBot({ commands: [SlowPanel] });
		const action = bot.slash({ name: 'slow-panel' }).then(() => {
			resolved = true;
		});
		await bot.waitForAction(candidate => candidate.route.includes('/callback'));
		expect(resolved).toBe(false);

		release();
		await action;
		expect(resolved).toBe(true);
		rendered(bot).get.button('eventual');
		await bot.close();
	});

	test('fails fast when waitFor does not match any rendered component', async () => {
		@Declare({ name: 'broken-checkpoint', description: 'Registers an impossible checkpoint' })
		class BrokenCheckpoint extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('visible').setLabel('Visible').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'Broken', components: [row] }, true);
				await message.createComponentCollector().waitFor('missing', 1);
			}
		}

		const bot = await createMockBot({ commands: [BrokenCheckpoint] });
		await expect(bot.slash({ name: 'broken-checkpoint' })).rejects.toThrow(
			/waiting for missing, but the rendered components are \[visible\]/,
		);
		await bot.close();
	});

	test('does not publish an input checkpoint for a stopped collector', async () => {
		const events: string[] = [];

		@Declare({ name: 'stopped-wait', description: 'Waits after its collector stopped' })
		class StoppedWait extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('stopped').setLabel('Stopped').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'initial', components: [row] }, true);
				const collector = message.createComponentCollector();
				collector.stop();
				await collector.waitFor('stopped');
				events.push('completed');
				await ctx.interaction.followup({ content: 'after stopped wait', components: [] });
			}
		}

		const bot = await createMockBot({ commands: [StoppedWait] });
		await bot.slash({ name: 'stopped-wait' });

		expect(events).toEqual(['completed']);
		rendered(bot).get.message({ content: 'after stopped wait' });
		await bot.close();
	});

	test('rejects a second stateful flow while the same session is busy', async () => {
		let release!: () => void;
		const held = new Promise<void>(resolve => {
			release = resolve;
		});

		@Declare({ name: 'held-flow', description: 'Stays busy without asking for input' })
		class HeldFlow extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'busy' });
				await held;
			}
		}

		@Declare({ name: 'other-flow', description: 'Must not join the held flow' })
		class OtherFlow extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'other' });
			}
		}

		const bot = await createMockBot({ commands: [HeldFlow, OtherFlow] });
		const first = bot.slash({ name: 'held-flow' });
		await bot.waitForAction(candidate => candidate.route.includes('/callback'));
		await expect(bot.slash({ name: 'other-flow' })).rejects.toThrow(/already has a pending flow/);
		release();
		await first;
		await bot.close();
	});

	test('keeps current output and component sources isolated per actor', async () => {
		@Declare({ name: 'actor-panel', description: 'One pending panel per actor' })
		class ActorPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('same-id').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: `panel:${ctx.author.id}`, components: [row] }, true);
				const click = await message.createComponentCollector().waitFor('same-id');
				if (click) await click.write({ content: `done:${click.user.id}`, components: [] });
			}
		}

		const bot = await createMockBot({ commands: [ActorPanel] });
		const alice = bot.actor({ user: apiUser({ id: 'alice' }) });
		const bob = bot.actor({ user: apiUser({ id: 'bob' }) });

		await Promise.all([alice.slash({ name: 'actor-panel' }), bob.slash({ name: 'actor-panel' })]);
		rendered(alice).get.message({ content: 'panel:alice' });
		rendered(bob).get.message({ content: 'panel:bob' });

		await alice.clickButton('same-id');
		rendered(alice).get.message({ content: 'done:alice' });
		rendered(bob).get.button('same-id');

		await bob.clickButton('same-id');
		rendered(bob).get.message({ content: 'done:bob' });
		await bot.close();
	});

	test('an explicit source lets another user drive the owning flow and updates the bot state', async () => {
		@Declare({ name: 'public-panel', description: 'A panel another user may drive' })
		class PublicPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('public-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: `panel:${ctx.author.id}`, components: [row] }, true);
				const click = await message.createComponentCollector().waitFor('public-continue');
				if (click) {
					await click.write({
						content: `done:${click.user.id}:${click.guildId}:${click.channel.id}`,
						components: [],
					});
				}
			}
		}

		const bot = await createMockBot({ commands: [PublicPanel] });
		const alice = bot.actor({
			user: apiUser({ id: 'alice' }),
			guildId: 'alice-guild',
			channel: apiChannel({ id: 'alice-channel', guildId: 'alice-guild' }),
		});
		const bob = bot.actor({
			user: apiUser({ id: 'bob' }),
			guildId: 'bob-guild',
			channel: apiChannel({ id: 'bob-channel', guildId: 'bob-guild' }),
		});

		await Promise.all([alice.slash({ name: 'public-panel' }), bob.slash({ name: 'public-panel' })]);
		const aliceReply = alice.currentActions.find(
			action => (action.body as { data?: { content?: string } } | undefined)?.data?.content === 'panel:alice',
		);
		const aliceMessageId = (aliceReply?.response as { resource?: { message?: { id?: string } } } | undefined)?.resource
			?.message?.id;
		expect(aliceMessageId).toBeTruthy();

		await bob.clickButton('public-continue', { source: aliceMessageId });
		rendered(bot).get.message({ content: 'done:bob:alice-guild:alice-channel' });
		rendered(alice).get.message({ content: 'done:bob:alice-guild:alice-channel' });
		rendered(bob).get.message({ content: 'panel:bob' });

		await bob.clickButton('public-continue');
		rendered(bob).get.message({ content: 'done:bob:bob-guild:bob-channel' });
		await bot.close();
	});

	test('supports global and sticky RegExp collector matches without mutating their state', async () => {
		@Declare({ name: 'regex-wait', description: 'Waits with a stateful regular expression' })
		class RegexWait extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('regex-go').setLabel('Go').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'regex panel', components: [row] }, true);
				const click = await message.createComponentCollector().waitFor(/^regex-go$/gy);
				if (click) await click.write({ content: 'regex complete', components: [] });
			}
		}

		const bot = await createMockBot({ commands: [RegexWait] });
		await bot.slash({ name: 'regex-wait' });
		await bot.clickButton('regex-go');

		rendered(bot).get.message({ content: 'regex complete' });
		await bot.close();
	});

	test('isolates two actors that share a user but use different locations', async () => {
		@Declare({ name: 'location-panel', description: 'One panel per actor location' })
		class LocationPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: `panel:${ctx.guildId}`, components: [row] }, true);
				const click = await message.createComponentCollector().waitFor('continue');
				if (click) await click.write({ content: `done:${click.guildId}`, components: [] });
			}
		}

		const bot = await createMockBot({ commands: [LocationPanel] });
		const sharedUser = apiUser({ id: 'shared-user' });
		const first = bot.actor({
			user: sharedUser,
			guildId: 'guild-one',
			channel: apiChannel({ id: 'channel-one', guildId: 'guild-one' }),
		});
		const second = bot.actor({
			user: sharedUser,
			guildId: 'guild-two',
			channel: apiChannel({ id: 'channel-two', guildId: 'guild-two' }),
		});

		await Promise.all([first.slash({ name: 'location-panel' }), second.slash({ name: 'location-panel' })]);
		rendered(first).get.message({ content: 'panel:guild-one' });
		rendered(second).get.message({ content: 'panel:guild-two' });

		await first.clickButton('continue');
		rendered(first).get.message({ content: 'done:guild-one' });
		rendered(second).get.button('continue');

		await second.clickButton('continue');
		rendered(second).get.message({ content: 'done:guild-two' });
		await bot.close();
	});

	test('propagates an opener error through the click that resumed it', async () => {
		@Declare({ name: 'explode-after-click', description: 'Fails after confirmation' })
		class ExplodeAfterClick extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('explode').setLabel('Explode').setStyle(ButtonStyle.Danger),
				]);
				const message = await ctx.write({ content: 'Confirm', components: [row] }, true);
				await message.createComponentCollector().waitFor('explode');
				throw new Error('creation failed');
			}
		}

		const bot = await createMockBot({ commands: [ExplodeAfterClick] });
		await bot.slash({ name: 'explode-after-click' });
		await expect(bot.clickButton('explode')).rejects.toThrow('creation failed');
		await bot.close();
	});
});
