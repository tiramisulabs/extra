import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	Declare,
	EntryPointCommand,
	Label,
	type MenuCommandContext,
	Modal,
	ModalCommand,
	type ModalContext,
	StringSelectMenu,
	type StringSelectMenuInteraction,
	StringSelectOption,
	TextInput,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, ButtonStyle, EntryPointCommandHandlerType, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot, rendered } from '../../src';
import { apiChannel, apiUser } from '../../src/bot/payloads';

describe('stateful interaction steps', () => {
	test('drives slash -> modal -> summary button -> completion from the bot state', async () => {
		const events: string[] = [];

		@Declare({ name: 'profile', description: 'Edit a profile' })
		class ProfileCommand extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('profile-modal')
						.setTitle('Profile')
						.setComponents([
							new Label().setLabel('Display name').setComponent(
								new TextInput({
									custom_id: 'display-name',
									style: TextInputStyle.Short,
								}),
							),
						]),
					{ waitFor: 30_000 },
				);
				if (!submit) return;

				events.push(`name:${submit.getInputValue('display-name')}`);
				events.push(`modal-context:${submit.guildId}:${submit.channel.id}`);
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('save-profile').setLabel('Save').setStyle(ButtonStyle.Primary),
				]);
				const summary = await submit.editOrReply({ content: 'Review profile', components: [row] }, true);
				const confirmation = await summary.createComponentCollector().waitFor('save-profile');
				if (!confirmation) return;

				events.push(`click-context:${confirmation.guildId}:${confirmation.channel.id}`);
				events.push('saved');
				await confirmation.write({
					content: 'Profile saved',
					components: [],
				});
			}
		}

		const bot = await createMockBot({ commands: [ProfileCommand] });
		const guildId = 'profile-guild';
		const channel = apiChannel({ id: 'profile-channel', guildId });

		await bot.slash({ name: 'profile', guildId, channel });
		rendered(bot).get.modal('profile-modal');

		await bot.submitModal('profile-modal', {
			'display-name': 'Ada',
		});
		expect(rendered(bot).query.modal('profile-modal')).toBeUndefined();
		rendered(bot).get.button('save-profile');
		expect(events).toEqual(['name:Ada', `modal-context:${guildId}:${channel.id}`]);

		await bot.clickButton('save-profile');
		expect(rendered(bot).query.button('save-profile')).toBeUndefined();
		rendered(bot).get.message({ content: 'Profile saved' });
		expect(events).toEqual([
			'name:Ada',
			`modal-context:${guildId}:${channel.id}`,
			`click-context:${guildId}:${channel.id}`,
			'saved',
		]);
		await expect(bot.clickButton('save-profile')).rejects.toThrow(/does not contain a component/);

		await bot.close();
	});

	test('does not yield merely because a button rendered before the handler finished', async () => {
		let release!: () => void;
		const paused = new Promise<void>(resolve => {
			release = resolve;
		});
		let markRendered!: () => void;
		const renderedEarly = new Promise<void>(resolve => {
			markRendered = resolve;
		});
		let resolved = false;

		@Declare({ name: 'slow-panel', description: 'Render before finishing non-input work' })
		class SlowPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('eventual').setLabel('Eventual').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'rendered early', components: [row] });
				markRendered();
				await paused;
			}
		}

		const bot = await createMockBot({ commands: [SlowPanel] });
		const action = bot.slash({ name: 'slow-panel' }).then(() => {
			resolved = true;
		});
		await renderedEarly;
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
		let markBusy!: () => void;
		const busyWritten = new Promise<void>(resolve => {
			markBusy = resolve;
		});

		@Declare({ name: 'held-flow', description: 'Stays busy without asking for input' })
		class HeldFlow extends Command {
			async run(ctx: CommandContext) {
				await ctx.write({ content: 'busy' });
				markBusy();
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
		await busyWritten;
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
		const aliceReply = alice
			.restCalls()
			.find(action => (action.body as { data?: { content?: string } } | undefined)?.data?.content === 'panel:alice');
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

	test('registered component and modal handlers are not actionable until their UI was rendered', async () => {
		class HiddenButton extends ComponentCommand {
			componentType = 'Button' as const;
			customId = 'hidden-button';
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'clicked' });
			}
		}

		class HiddenModal extends ModalCommand {
			customId = 'hidden-modal';
			async run(ctx: ModalContext) {
				await ctx.write({ content: 'submitted' });
			}
		}

		const bot = await createMockBot({ components: [HiddenButton, HiddenModal] });
		await expect(bot.clickButton('hidden-button')).rejects.toThrow(/not available in the current state/);
		await expect(bot.submitModal('hidden-modal')).rejects.toThrow(/not available in the current state/);
		await bot.close();
	});

	test('a rendered entry-point button can be handled by a ComponentCommand', async () => {
		class EntryContinue extends ComponentCommand {
			componentType = 'Button' as const;
			customId = 'entry-continue';
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'entry complete' });
			}
		}

		class PreferencesEntry extends EntryPointCommand {
			name = 'preferences';
			description = 'Open preferences';
			handler = EntryPointCommandHandlerType.AppHandler;

			async run(ctx: Parameters<NonNullable<EntryPointCommand['run']>>[0]) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('entry-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Entry panel', components: [row] });
			}
		}

		const bot = await createMockBot({ commands: [PreferencesEntry], components: [EntryContinue] });
		await bot.entryPoint({ name: 'preferences' });
		rendered(bot).get.button('entry-continue');

		await bot.clickButton('entry-continue');
		rendered(bot).get.message({ content: 'entry complete' });
		await bot.close();
	});

	test('a context menu can open a stateful modal and resume after submit', async () => {
		class EditPreferences extends ContextMenuCommand {
			type = ApplicationCommandType.User as const;
			name = 'Edit Preferences';

			async run(ctx: MenuCommandContext<UserCommandInteraction>) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('preferences-modal')
						.setTitle('Preferences')
						.setComponents([
							new Label().setLabel('Theme').setComponent(
								new TextInput({
									custom_id: 'theme',
									style: TextInputStyle.Short,
								}),
							),
						]),
					{ waitFor: 30_000 },
				);
				if (submit) await submit.write({ content: `theme:${submit.getInputValue('theme')}` });
			}
		}

		const bot = await createMockBot({ commands: [EditPreferences] });
		const actor = bot.actor({ user: apiUser({ id: 'preferences-editor' }) });
		await actor.userMenu({
			name: 'Edit Preferences',
			target: apiUser({ id: 'preferences-target' }),
		});
		rendered(actor).get.modal('preferences-modal');

		await actor.submitModal('preferences-modal', { theme: 'dark' });
		rendered(actor).get.message({ content: 'theme:dark' });
		await bot.close();
	});

	test('a modal rendered without waitFor can be submitted to a ModalCommand', async () => {
		@Declare({ name: 'open-preferences', description: 'Open preferences' })
		class OpenPreferences extends Command {
			async run(ctx: CommandContext) {
				await ctx.interaction.modal(
					new Modal()
						.setCustomId('standalone-preferences')
						.setTitle('Preferences')
						.setComponents([
							new Label().setLabel('Locale').setComponent(
								new TextInput({
									custom_id: 'locale',
									style: TextInputStyle.Short,
								}),
							),
						]),
				);
			}
		}

		class PreferencesModal extends ModalCommand {
			customId = 'standalone-preferences';
			async run(ctx: ModalContext) {
				await ctx.write({ content: `locale:${ctx.interaction.getInputValue('locale')}` });
			}
		}

		const bot = await createMockBot({ commands: [OpenPreferences], components: [PreferencesModal] });
		await bot.slash({ name: 'open-preferences' });
		rendered(bot).get.modal('standalone-preferences');

		await bot.submitModal('standalone-preferences', { locale: 'es' });
		rendered(bot).get.message({ content: 'locale:es' });
		await bot.close();
	});

	test('a consumed waitFor modal cannot be submitted again without synthetic opt-in', async () => {
		let fallbackRuns = 0;

		@Declare({ name: 'single-use-modal', description: 'Opens a single-use modal' })
		class OpenSingleUseModal extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('single-use-modal')
						.setTitle('Single use')
						.setComponents([
							new Label().setLabel('Value').setComponent(
								new TextInput({
									custom_id: 'value',
									style: TextInputStyle.Short,
								}),
							),
						]),
					{ waitFor: 30_000 },
				);
				if (submit) await submit.write({ content: `accepted:${submit.getInputValue('value')}` });
			}
		}

		class SingleUseFallback extends ModalCommand {
			customId = 'single-use-modal';
			async run(ctx: ModalContext) {
				fallbackRuns++;
				await ctx.write({ content: 'synthetic fallback' });
			}
		}

		const bot = await createMockBot({
			commands: [OpenSingleUseModal],
			components: [SingleUseFallback],
		});
		await bot.slash({ name: 'single-use-modal' });
		await bot.submitModal('single-use-modal', { value: 'first' });

		rendered(bot).get.message({ content: 'accepted:first' });
		expect(fallbackRuns).toBe(0);
		expect(() => bot.dispatch.submitModal('single-use-modal', { value: 'second' })).toThrow(/not rendered/);
		expect(fallbackRuns).toBe(0);

		await expect(
			bot.dispatch.submitModal('single-use-modal', { value: 'synthetic' }, { allowSyntheticSource: true }),
		).resolves.toMatchObject({ content: 'synthetic fallback' });
		expect(fallbackRuns).toBe(1);
		await bot.close();
	});

	test('invalid select values do not consume the checkpoint before a valid selection', async () => {
		@Declare({ name: 'choose-theme', description: 'Choose a theme' })
		class ChooseTheme extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<StringSelectMenu>().setComponents([
					new StringSelectMenu()
						.setCustomId('theme-select')
						.setOptions([
							new StringSelectOption().setLabel('Dark').setValue('dark'),
							new StringSelectOption().setLabel('Light').setValue('light'),
						]),
				]);
				const message = await ctx.write({ content: 'Choose', components: [row] }, true);
				const select = await message.createComponentCollector().waitFor<StringSelectMenuInteraction>('theme-select');
				if (select) await select.write({ content: `selected:${select.values[0]}`, components: [] });
			}
		}

		const bot = await createMockBot({ commands: [ChooseTheme] });
		await bot.slash({ name: 'choose-theme' });
		await expect(bot.selectMenu('theme-select', ['unknown'])).rejects.toThrow(/is not an option/);
		rendered(bot).get.select('theme-select');

		await bot.selectMenu('theme-select', ['dark']);
		rendered(bot).get.message({ content: 'selected:dark' });
		await bot.close();
	});

	test('a disabled component rejection preserves the checkpoint for another valid button', async () => {
		@Declare({ name: 'choose-action', description: 'Choose an action' })
		class ChooseAction extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button()
						.setCustomId('disabled-action')
						.setLabel('Disabled')
						.setStyle(ButtonStyle.Secondary)
						.setDisabled(true),
					new Button().setCustomId('enabled-action').setLabel('Enabled').setStyle(ButtonStyle.Primary),
				]);
				const message = await ctx.write({ content: 'Choose', components: [row] }, true);
				const click = await message.createComponentCollector().waitFor(['disabled-action', 'enabled-action']);
				if (click) await click.write({ content: `clicked:${click.customId}`, components: [] });
			}
		}

		const bot = await createMockBot({ commands: [ChooseAction] });
		await bot.slash({ name: 'choose-action' });
		await expect(bot.clickButton('disabled-action')).rejects.toThrow(/disabled/);
		rendered(bot).get.button('enabled-action');

		await bot.clickButton('enabled-action');
		rendered(bot).get.message({ content: 'clicked:enabled-action' });
		await bot.close();
	});

	test('a ghost modal field does not consume the checkpoint before a valid submit', async () => {
		@Declare({ name: 'edit-locale', description: 'Edit locale' })
		class EditLocale extends Command {
			async run(ctx: CommandContext) {
				const submit = await ctx.interaction.modal(
					new Modal()
						.setCustomId('locale-modal')
						.setTitle('Locale')
						.setComponents([
							new Label().setLabel('Locale').setComponent(
								new TextInput({
									custom_id: 'locale',
									style: TextInputStyle.Short,
								}),
							),
						]),
					{ waitFor: 30_000 },
				);
				if (submit) await submit.write({ content: `locale:${submit.getInputValue('locale')}` });
			}
		}

		const bot = await createMockBot({ commands: [EditLocale] });
		await bot.slash({ name: 'edit-locale' });
		await expect(bot.submitModal('locale-modal', { ghost: 'x' })).rejects.toThrow(/not inputs/);
		rendered(bot).get.modal('locale-modal');

		await bot.submitModal('locale-modal', { locale: 'es' });
		rendered(bot).get.message({ content: 'locale:es' });
		await bot.close();
	});

	test('raw synthetic component and modal dispatches require explicit opt-in', async () => {
		class SyntheticButton extends ComponentCommand {
			componentType = 'Button' as const;
			customId = 'synthetic-button';
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'raw button' });
			}
		}

		class SyntheticModal extends ModalCommand {
			customId = 'synthetic-modal';
			async run(ctx: ModalContext) {
				await ctx.write({ content: 'raw modal' });
			}
		}

		class SyntheticSelect extends ComponentCommand {
			componentType = 'StringSelect' as const;
			customId = 'synthetic-select';
			async run(ctx: ComponentContext<'StringSelect'>) {
				await ctx.write({ content: `raw select:${ctx.interaction.values[0]}` });
			}
		}

		const bot = await createMockBot({ components: [SyntheticButton, SyntheticModal, SyntheticSelect] });
		expect(() => bot.dispatch.clickButton('synthetic-button')).toThrow(/allowSyntheticSource: true/);
		expect(() => bot.dispatch.selectMenu('synthetic-select', ['dark'])).toThrow(/allowSyntheticSource: true/);
		expect(() => bot.dispatch.submitModal('synthetic-modal')).toThrow(/allowSyntheticSource: true/);

		const button = bot.dispatch.clickButton('synthetic-button', { allowSyntheticSource: true });
		const select = bot.dispatch.selectMenu('synthetic-select', ['dark'], { allowSyntheticSource: true });
		const modal = bot.dispatch.submitModal('synthetic-modal', {}, { allowSyntheticSource: true });
		await expect(button).resolves.toMatchObject({ content: 'raw button' });
		await expect(select).resolves.toMatchObject({ content: 'raw select:dark' });
		await expect(modal).resolves.toMatchObject({ content: 'raw modal' });
		await bot.close();
	});
});
