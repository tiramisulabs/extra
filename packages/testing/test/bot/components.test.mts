import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	Label,
	Modal,
	ModalCommand,
	type ModalContext,
	StringSelectMenu,
	type StringSelectMenuInteraction,
	StringSelectOption,
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { ConfirmButton } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('component flows', () => {
	test('clickButton reaches a component collector on the sent message', async () => {
		const clicked: string[] = [];

		@Declare({ name: 'poll', description: 'Starts a poll' })
		class PollCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new Button().setCustomId('poll/yes').setLabel('Yes').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Vote now', components: [row] });
				const message = await ctx.fetchResponse();
				const collector = message.createComponentCollector();
				collector.run('poll/yes', async interaction => {
					clicked.push(interaction.customId);
					await interaction.write({ content: 'Voted!' });
				});
			}
		}

		const bot = await createMockBot({ commands: [PollCommand] });
		await bot.slash({ name: 'poll' });
		const result = await bot.clickButton('poll/yes');
		expect(clicked).toEqual(['poll/yes']);
		expect(result.reply?.body).toMatchObject({ data: { content: 'Voted!' } });
		await bot.close();
	});

	test('rendered button views can click themselves with their source message', async () => {
		const clicked: string[] = [];

		@Declare({ name: 'self-click-panel', description: 'Posts a clickable panel' })
		class SelfClickPanelCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new Button().setCustomId('self-click').setLabel('Self Click').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Panel', components: [row] });
				const message = await ctx.fetchResponse();
				message.createComponentCollector().run('self-click', async interaction => {
					clicked.push(interaction.customId);
					await interaction.write({ content: 'clicked via view' });
				});
			}
		}

		const bot = await createMockBot({ commands: [SelfClickPanelCommand] });
		const panel = await bot.slash({ name: 'self-click-panel' });
		const component = panel.component('Self Click');
		expect(component?.source?.messageId).toBeTypeOf('string');

		const result = await component?.click();

		expect(clicked).toEqual(['self-click']);
		expect(result?.content).toBe('clicked via view');
		await bot.close();
	});

	test('clickButton without a source fails by default for ComponentCommand-only dispatch', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		expect(() => bot.clickButton('confirm')).toThrow(/no source message resolved/);
		await bot.close();
	});

	test('clickButton can explicitly use a synthetic source for ComponentCommand handlers', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		const result = await bot.clickButton('confirm', { allowSyntheticSource: true });
		expect(result.reply?.body).toMatchObject({ data: { content: 'Confirmed!' } });
		await bot.close();
	});

	test('disabled source components cannot be dispatched', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		await bot.rest.request('POST', '/channels/disabled-channel/messages', {
			body: {
				content: 'disabled',
				components: [
					{
						type: 1,
						components: [{ type: 2, style: 1, custom_id: 'confirm', label: 'Confirm', disabled: true }],
					},
				],
			},
		});
		const source = bot.actions.at(-1);
		if (!source) throw new Error('expected source message action');

		expect(() => bot.clickButton('confirm', { source })).toThrow(/component "confirm".+disabled/);
		await bot.close();
	});

	test('selectMenu without a source fails by default for ComponentCommand-only dispatch', async () => {
		class PickComponent extends ComponentCommand {
			componentType = 'StringSelect' as const;
			filter(ctx: ComponentContext<'StringSelect'>) {
				return ctx.customId === 'pick-synthetic';
			}
			async run(ctx: ComponentContext<'StringSelect'>) {
				await ctx.write({ content: ctx.interaction.values.join(',') });
			}
		}

		const bot = await createMockBot({ components: [PickComponent] });
		expect(() => bot.selectMenu('pick-synthetic', ['red'])).toThrow(/no source message resolved/);
		await bot.close();
	});

	test('allowSyntheticSource does not ignore an implicitly resolved wrong source message', async () => {
		@Declare({ name: 'wrong-source', description: 'Posts unrelated components' })
		class WrongSourceCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow<Button>().setComponents([
					new Button().setCustomId('other-confirm').setLabel('Other').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Wrong source', components: [row] });
			}
		}

		class PickComponent extends ComponentCommand {
			componentType = 'StringSelect' as const;
			filter(ctx: ComponentContext<'StringSelect'>) {
				return ctx.customId === 'pick-synthetic';
			}
			async run(ctx: ComponentContext<'StringSelect'>) {
				await ctx.write({ content: ctx.interaction.values.join(',') });
			}
		}

		const bot = await createMockBot({ commands: [WrongSourceCommand], components: [ConfirmButton, PickComponent] });
		await bot.slash({ name: 'wrong-source' });

		expect(() => bot.clickButton('confirm', { allowSyntheticSource: true })).toThrow(
			/source message ".+" does not contain a component with customId "confirm"/,
		);
		expect(() => bot.selectMenu('pick-synthetic', ['red'], { allowSyntheticSource: true })).toThrow(
			/source message ".+" does not contain a component with customId "pick-synthetic"/,
		);
		await bot.close();
	});

	test('component dispatch throws when no collector or component command handles the customId', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });

		await expect(bot.clickButton('missing-confirm', { allowSyntheticSource: true })).rejects.toThrow(
			/no handler matched customId "missing-confirm".+ConfirmButton \(filter rejected "missing-confirm"\)/s,
		);
		await bot.close();
	});

	test('component dispatch diagnoses when no component handlers are registered at all', async () => {
		const bot = await createMockBot({ components: [] });

		expect(() => bot.clickButton('poll_yes', { source: 'source-message-id' })).toThrow(
			/source message "source-message-id" was not found/,
		);
		await bot.close();
	});

	test('explicit component source must contain the dispatched customId', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'source-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'source-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'source-channel' });
		world.registerMessage(channel.id, {
			id: 'source-message',
			components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: 'other-confirm', label: 'Other' }] }],
		});

		const bot = await createMockBot({ components: [ConfirmButton], world });
		expect(() =>
			bot.clickButton('confirm', { source: 'source-message', guildId: guild.id, channel, user: actor.user }),
		).toThrow(/source message "source-message" does not contain a component with customId "confirm"/);
		await bot.close();
	});

	test('component dispatch names the registered handler and reports its customId rejected the dispatch', async () => {
		class PollButton extends ComponentCommand {
			componentType = 'Button' as const;
			customId = 'poll/yes';
			async run(ctx: ComponentContext<'Button'>) {
				await ctx.write({ content: 'voted' });
			}
		}

		const bot = await createMockBot({ components: [PollButton] });

		const error = await bot.clickButton('poll_yes', { allowSyntheticSource: true }).then(
			() => undefined,
			(reason: unknown) => reason as Error,
		);
		expect(error).toBeInstanceOf(TypeError);
		expect(error?.message).toContain('no handler matched customId "poll_yes"');
		expect(error?.message).toContain('PollButton');
		expect(error?.message).toContain('customId "poll/yes" rejected "poll_yes"');
		await bot.close();
	});

	test('selectMenu reaches a component collector and exposes selected values', async () => {
		const selected: string[][] = [];

		@Declare({ name: 'pick-color', description: 'Starts a color picker' })
		class PickColorCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new StringSelectMenu()
						.setCustomId('pick')
						.setOptions([new StringSelectOption().setLabel('Red').setValue('red')]),
				]);
				await ctx.write({ content: 'Pick one', components: [row] });
				const message = await ctx.fetchResponse();
				const collector = message.createComponentCollector();
				collector.run<StringSelectMenuInteraction>('pick', async interaction => {
					selected.push(interaction.values);
					await interaction.write({ content: `Picked ${interaction.values.join(',')}` });
				});
			}
		}

		const bot = await createMockBot({ commands: [PickColorCommand] });
		const panel = await bot.slash({ name: 'pick-color' });
		const picker = panel.component('pick');
		expect(picker?.source?.messageId).toBeTypeOf('string');
		const result = await picker?.select(['red']);
		expect(selected).toEqual([['red']]);
		expect(result?.content).toBe('Picked red');
		await bot.close();
	});

	test('selectMenu validates selected values against the source string select', async () => {
		@Declare({ name: 'pick-strict-color', description: 'Starts a strict color picker' })
		class PickStrictColorCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new StringSelectMenu()
						.setCustomId('strict-pick')
						.setOptions([
							new StringSelectOption().setLabel('Red').setValue('red'),
							new StringSelectOption().setLabel('Blue').setValue('blue'),
						]),
				]);
				await ctx.write({ content: 'Pick one', components: [row] });
				const message = await ctx.fetchResponse();
				message.createComponentCollector().run<StringSelectMenuInteraction>('strict-pick', async interaction => {
					await interaction.write({ content: `Picked ${interaction.values.join(',')}` });
				});
			}
		}

		const bot = await createMockBot({ commands: [PickStrictColorCommand] });
		await bot.slash({ name: 'pick-strict-color' });
		expect(() => bot.selectMenu('strict-pick', ['green'])).toThrow(/value "green" is not an option/);
		expect(() => bot.selectMenu('strict-pick', ['red', 'blue'])).toThrow(/above max_values 1/);
		await bot.close();
	});

	test('clickButton on a customId the message declares as a select fails loud (wrong verb)', async () => {
		@Declare({ name: 'menu', description: 'Posts a select menu' })
		class MenuCommand extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new StringSelectMenu()
						.setCustomId('pick')
						.setOptions([new StringSelectOption().setLabel('Red').setValue('red')]),
				]);
				await ctx.write({ content: 'Pick one', components: [row] });
				const message = await ctx.fetchResponse();
				message.createComponentCollector().run<StringSelectMenuInteraction>('pick', async () => {});
			}
		}

		const bot = await createMockBot({ commands: [MenuCommand] });
		await bot.slash({ name: 'menu' });
		expect(() => bot.clickButton('pick')).toThrow(/is a select menu \(type 3\), not a button.+selectMenu/s);
		await bot.close();
	});

	test('selectMenu on a customId the message declares as a button fails loud (wrong verb)', async () => {
		@Declare({ name: 'confirm-panel', description: 'Posts a button' })
		class ConfirmPanel extends Command {
			async run(ctx: CommandContext) {
				const row = new ActionRow().setComponents([
					new Button().setCustomId('go').setLabel('Go').setStyle(ButtonStyle.Primary),
				]);
				await ctx.write({ content: 'Press it', components: [row] });
				const message = await ctx.fetchResponse();
				message.createComponentCollector().run('go', async () => {});
			}
		}

		const bot = await createMockBot({ commands: [ConfirmPanel] });
		await bot.slash({ name: 'confirm-panel' });
		expect(() => bot.selectMenu('go', ['x'])).toThrow(/is a button \(type 2\), not a select menu.+clickButton/s);
		await bot.close();
	});

	test('selectMenu auto-resolves seeded entity select values', async () => {
		const seen: string[][] = [];
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'select-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'select-actor' }) });
		const role = world.registerRole(guild.id, { id: 'select-role', name: 'Mods' });
		const channel = world.registerChannel(guild.id);

		class RoleSelectComponent extends ComponentCommand {
			componentType = 'RoleSelect' as const;
			filter(ctx: ComponentContext<'RoleSelect'>) {
				return ctx.customId === 'settings/mod';
			}
			async run(ctx: ComponentContext<'RoleSelect'>) {
				seen.push(ctx.interaction.roles.map(entry => entry.id));
				await ctx.write({ content: ctx.interaction.roles.map(entry => entry.name).join(',') });
			}
		}

		const bot = await createMockBot({ components: [RoleSelectComponent], world });
		const result = await bot.selectMenu('settings/mod', [role.id], {
			componentType: 'role',
			guildId: guild.id,
			channel,
			user: actor.user,
			allowSyntheticSource: true,
		});
		expect(seen).toEqual([[role.id]]);
		expect(result.content).toBe('Mods');
		await bot.close();

		const missingBot = await createMockBot({ components: [RoleSelectComponent], world });
		expect(() =>
			missingBot.selectMenu('settings/mod', ['missing-role'], {
				componentType: 'role',
				guildId: guild.id,
				channel,
				user: actor.user,
				allowSyntheticSource: true,
			}),
		).toThrow(/Seeded roles: select-guild, select-role/);
		await missingBot.close();
	});

	test('selectMenu resolves seeded guild members without explicit permissions', async () => {
		const seen: string[][] = [];
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'user-select-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'user-select-actor' }) });
		const target = world.registerMember(guild.id, {
			user: apiUser({ id: 'user-select-target', username: 'target' }),
		});
		const channel = world.registerChannel(guild.id);

		class UserSelectComponent extends ComponentCommand {
			componentType = 'UserSelect' as const;
			filter(ctx: ComponentContext<'UserSelect'>) {
				return ctx.customId === 'settings/user';
			}
			async run(ctx: ComponentContext<'UserSelect'>) {
				seen.push(ctx.interaction.members.map(entry => entry.user.id));
				await ctx.write({ content: ctx.interaction.members.map(entry => entry.user.username).join(',') });
			}
		}

		const bot = await createMockBot({ components: [UserSelectComponent], world });
		const result = await bot.selectMenu('settings/user', [target.user.id], {
			componentType: 'user',
			guildId: guild.id,
			channel,
			user: actor.user,
			allowSyntheticSource: true,
		});
		expect(seen).toEqual([[target.user.id]]);
		expect(result.content).toBe('target');
		await bot.close();
	});

	test('fillModal reaches values through ModalContext getInputValue', async () => {
		class ProfileModal extends ModalCommand {
			filter(ctx: ModalContext) {
				return ctx.customId === 'profile';
			}
			async run(ctx: ModalContext) {
				const username = ctx.interaction.getInputValue('username', true);
				await ctx.write({ content: `profile:${username}` });
			}
		}

		const bot = await createMockBot({ components: [ProfileModal] });
		const result = await bot.fillModal('profile', { username: 'neo' });
		expect(result.content).toBe('profile:neo');
		await bot.close();
	});

	test('modal dispatch throws when no waiting modal or modal command handles the customId', async () => {
		class ProfileModal extends ModalCommand {
			filter(ctx: ModalContext) {
				return ctx.customId === 'profile';
			}
			async run(ctx: ModalContext) {
				await ctx.write({ content: 'profile' });
			}
		}

		const bot = await createMockBot({ components: [ProfileModal] });

		await expect(bot.fillModal('missing-profile', { username: 'neo' })).rejects.toThrow(
			/no handler matched customId "missing-profile".+ProfileModal \(filter rejected "missing-profile"\)/s,
		);
		await bot.close();
	});

	test('a modal opened from a button resolves via fillModal from the same user', async () => {
		const submitted: string[] = [];

		class FeedbackButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'open-feedback';
			}
			async run(ctx: ComponentContext<'Button'>) {
				const modal = new Modal()
					.setCustomId('feedback-modal')
					.setTitle('Feedback')
					.setComponents([
						new Label()
							.setLabel('Rating')
							.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
					]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 2000 });
				if (submit) {
					submitted.push(submit.user.id);
					await submit.write({ content: 'thanks' });
				}
			}
		}

		const bot = await createMockBot({ components: [FeedbackButton] });
		const user = apiUser({ id: '777' });

		const dispatch = bot.clickButton('open-feedback', { user, allowSyntheticSource: true });
		await dispatch.untilModal();
		const modal = await bot.fillModal('feedback-modal', { rating: '5' }, { user });
		await dispatch;

		expect(submitted).toEqual(['777']);
		expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
		await bot.close();
	});

	class FeedbackModalButton extends ComponentCommand {
		componentType = 'Button' as const;
		filter(ctx: ComponentContext<'Button'>) {
			return ctx.customId === 'open-feedback';
		}
		async run(ctx: ComponentContext<'Button'>) {
			const modal = new Modal()
				.setCustomId('feedback-modal')
				.setTitle('Feedback')
				.setComponents([
					new Label()
						.setLabel('Rating')
						.setComponent(new TextInput({ custom_id: 'rating', style: TextInputStyle.Short })),
				]);
			const submit = await ctx.interaction.modal(modal, { waitFor: 2000 });
			if (submit) await submit.write({ content: 'thanks' });
		}
	}

	test('fillModal aimed at the wrong customId fails loud against the displayed modal', async () => {
		const bot = await createMockBot({ components: [FeedbackModalButton] });
		const user = apiUser({ id: '778' });
		const dispatch = bot.clickButton('open-feedback', { user, allowSyntheticSource: true });
		await expect(dispatch.fillModal('wrong-modal', { rating: '5' })).rejects.toThrow(
			/displayed modal's customId is "feedback-modal", not "wrong-modal"/,
		);
		await dispatch.timeoutModal();
		await bot.close();
	});

	test('fillModal with a field key no input declares fails loud (ghost field)', async () => {
		const bot = await createMockBot({ components: [FeedbackModalButton] });
		const user = apiUser({ id: '779' });
		const dispatch = bot.clickButton('open-feedback', { user, allowSyntheticSource: true });
		await expect(dispatch.fillModal('feedback-modal', { bogus: 'x' })).rejects.toThrow(
			/field\(s\) "bogus" are not inputs on the displayed modal.+Known inputs: rating/s,
		);
		await dispatch.timeoutModal();
		await bot.close();
	});
});
