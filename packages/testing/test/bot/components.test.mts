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

	test('clickButton with no prior message uses a fresh one for ComponentCommand handlers', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		const result = await bot.clickButton('confirm');
		expect(result.reply?.body).toMatchObject({ data: { content: 'Confirmed!' } });
		await bot.close();
	});

	test('component dispatch throws when no collector or component command handles the customId', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });

		await expect(bot.clickButton('missing-confirm')).rejects.toThrow(
			/no handler matched customId "missing-confirm".+ConfirmButton \(filter rejected "missing-confirm"\)/s,
		);
		await bot.close();
	});

	test('component dispatch diagnoses when no component handlers are registered at all', async () => {
		const bot = await createMockBot({ components: [] });

		await expect(bot.clickButton('poll_yes', { source: 'source-message-id' })).rejects.toThrow(
			/no component handlers are registered/,
		);
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

		const error = await bot.clickButton('poll_yes').then(
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
		await bot.slash({ name: 'pick-color' });
		const result = await bot.selectMenu('pick', ['red']);
		expect(selected).toEqual([['red']]);
		expect(result.content).toBe('Picked red');
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
		});
		expect(seen).toEqual([[role.id]]);
		expect(result.content).toBe('Mods');
		expect(() =>
			bot.selectMenu('settings/mod', ['missing-role'], {
				componentType: 'role',
				guildId: guild.id,
				channel,
				user: actor.user,
			}),
		).toThrow(/Seeded roles: select-guild, select-role/);
		await bot.close();
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

		const dispatch = bot.clickButton('open-feedback', { user });
		await dispatch.untilModal();
		const modal = await bot.fillModal('feedback-modal', { rating: '5' }, { user });
		await dispatch;

		expect(submitted).toEqual(['777']);
		expect(modal.reply?.body).toMatchObject({ data: { content: 'thanks' } });
		await bot.close();
	});
});
