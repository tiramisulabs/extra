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
	type ParseLocales,
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
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
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
