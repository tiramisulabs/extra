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
import { apiActionRow, apiButton, apiSelect, apiTextInput, apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';
import { rendered } from '../../src/rendered-output';
import { ConfirmButton, seedGuildFixture } from './_setup';

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

	test('dispatch results expose component data while actions stay on bot', async () => {
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
		expect(panel.components.find(component => component.label === 'Self Click')?.customId).toBe('self-click');

		const result = await bot.clickButton('self-click');
		expect(clicked).toEqual(['self-click']);
		expect(result.content).toBe('clicked via view');
		await bot.close();
	});

	test('stateful clickButton rejects a registered ComponentCommand that was never rendered', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		await expect(bot.clickButton('confirm')).rejects.toThrow(/not available in the current state/);
		await bot.close();
	});

	test('clickButton can explicitly use a synthetic source for ComponentCommand handlers', async () => {
		const bot = await createMockBot({ components: [ConfirmButton] });
		const result = await bot.clickButton('confirm', { allowSyntheticSource: true });
		expect(result.reply?.body).toMatchObject({ data: { content: 'Confirmed!' } });
		await bot.close();
	});

	test('component dispatch exposes seeded member role objects through ctx.member.roles.list()', async () => {
		const seen: string[][] = [];
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'component-role-list-guild' });
		const role = world.registerRole(guild.id, { id: 'role-allowed', name: 'Component Role' });
		const actor = world.registerMember(guild.id, {
			user: apiUser({ id: 'component-role-list-user' }),
			roles: [role.id],
		});
		const channel = world.registerChannel(guild.id);

		class RoleListButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'role-list';
			}
			async run(ctx: ComponentContext<'Button'>) {
				const roles = await ctx.member!.roles.list();
				seen.push(roles.map(entry => entry.id));
				await ctx.write({ content: roles.map(entry => entry.name).join(',') });
			}
		}

		const bot = await createMockBot({ components: [RoleListButton], world });
		const result = await bot.clickButton('role-list', {
			guildId: guild.id,
			channel,
			user: actor.user,
			allowSyntheticSource: true,
		});
		expect(seen.at(-1)).toContain(role.id);
		expect(result.content).toContain(role.name);
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
		const source = bot.rest.actions.at(-1);
		if (!source) throw new Error('expected source message action');

		await expect(bot.clickButton('confirm', { source })).rejects.toThrow(/component "confirm".+disabled/);
		await bot.close();
	});

	test('stateful selectMenu rejects a registered ComponentCommand that was never rendered', async () => {
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
		await expect(bot.selectMenu('pick-synthetic', ['red'])).rejects.toThrow(/not available in the current state/);
		await bot.close();
	});

	test('a wrong implicitly resolved source fails loud, and allowSyntheticSource opts out of it', async () => {
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

		const raw = bot.actor({ session: false });
		// Without the claim, the implicitly resolved message IS the source, and it lacks the component.
		expect(() => raw.clickButton('confirm')).toThrow(
			/source message ".+" does not contain a component with customId "confirm"/,
		);
		expect(() => raw.selectMenu('pick-synthetic', ['red'])).toThrow(
			/source message ".+" does not contain a component with customId "pick-synthetic"/,
		);
		// With it, a candidate that does not carry the component is a coincidence, not a source — on both
		// surfaces, so the option means one thing wherever it is passed.
		expect(await raw.clickButton('confirm', { allowSyntheticSource: true })).toMatchObject({
			content: 'Confirmed!',
		});
		expect(await bot.selectMenu('pick-synthetic', ['red'], { allowSyntheticSource: true })).toMatchObject({
			content: 'red',
		});
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

		await expect(bot.clickButton('poll_yes', { source: 'source-message-id' })).rejects.toThrow(
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
		await expect(
			bot.clickButton('confirm', { source: 'source-message', guildId: guild.id, channel, user: actor.user }),
		).rejects.toThrow(/source message "source-message" does not contain a component with customId "confirm"/);
		await bot.close();
	});

	test('a seeded panel can be built from the component factories instead of a wire literal', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'panel-guild' });
		const clicker = world.registerMember(guild.id, { user: apiUser({ id: 'panel-clicker' }) });
		const channel = world.registerChannel(guild.id, { id: 'panel-channel' });
		world.registerMessage(channel.id, {
			id: 'panel-message',
			components: [apiActionRow(apiButton({ customId: 'confirm', label: 'Confirm', style: 'danger' }))],
		});

		const bot = await createMockBot({ components: [ConfirmButton], world });
		const result = await bot.clickButton('confirm', {
			source: 'panel-message',
			guildId: guild.id,
			channel,
			user: clicker.user,
		});

		// the source-validation guard is what makes the seeded component mandatory: it passed, so the
		// factory produced the same shape the hand-written literal did
		expect(rendered(result).get.message().content).toBe('Confirmed!');
		await bot.close();
	});

	test('apiSelect and apiTextInput carry the fields their component kinds need', () => {
		const select = apiSelect({
			customId: 'pick',
			placeholder: 'Choose',
			options: [{ label: 'One', value: '1' }],
		});
		const userSelect = apiSelect({ customId: 'who', type: 'user' });
		const input = apiTextInput({ customId: 'title', label: 'Title', style: 2 });

		expect(select).toMatchObject({ type: 3, custom_id: 'pick', placeholder: 'Choose' });
		expect(select.options).toEqual([{ label: 'One', value: '1' }]);
		// non-string selects resolve their values from the guild, so they carry no options array
		expect(userSelect).toMatchObject({ type: 5, custom_id: 'who' });
		expect(userSelect).not.toHaveProperty('options');
		expect(input).toMatchObject({ type: 4, custom_id: 'title', label: 'Title', style: 2 });
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
		expect(panel.components.find(component => component.customId === 'pick')?.type).toBe(3);
		const result = await bot.selectMenu('pick', ['red']);
		expect(selected).toEqual([['red']]);
		expect(result.content).toBe('Picked red');
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
		await expect(bot.selectMenu('strict-pick', ['green'])).rejects.toThrow(/value "green" is not an option/);
		await expect(bot.selectMenu('strict-pick', ['red', 'blue'])).rejects.toThrow(/above max_values 1/);
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
		await expect(bot.clickButton('pick')).rejects.toThrow(/is a select menu \(type 3\), not a button.+selectMenu/s);
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
		await expect(bot.selectMenu('go', ['x'])).rejects.toThrow(
			/is a button \(type 2\), not a select menu.+clickButton/s,
		);
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
			missingBot.actor({ session: false }).selectMenu('settings/mod', ['missing-role'], {
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

	test('submitModal reaches values through ModalContext getInputValue', async () => {
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
		const result = await bot.submitModal('profile', { username: 'neo' }, { allowSyntheticSource: true });
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

		await expect(
			bot.submitModal('missing-profile', { username: 'neo' }, { allowSyntheticSource: true }),
		).rejects.toThrow(
			/no handler matched customId "missing-profile".+ProfileModal \(filter rejected "missing-profile"\)/s,
		);
		await bot.close();
	});

	test('a modal opened from a button resolves via submitModal from the same user', async () => {
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

		const modal = await bot
			.actor({ session: false })
			.clickButton('open-feedback', { user, allowSyntheticSource: true })
			.submitModal('feedback-modal', { rating: '5' });

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

	test('submitModal aimed at the wrong customId fails loud against the displayed modal', async () => {
		const bot = await createMockBot({ components: [FeedbackModalButton] });
		const user = apiUser({ id: '778' });
		const raw = bot.actor({ session: false });
		const opener = raw.clickButton('open-feedback', { user, allowSyntheticSource: true });
		await opener.untilModal();
		expect(() => raw.submitModal('wrong-modal', { rating: '5' }, { user })).toThrow(
			/displayed modal's customId is "feedback-modal", not "wrong-modal"/,
		);
		await raw.submitModal('feedback-modal', { rating: '5' }, { user });
		await opener;
		await bot.close();
	});

	test('submitModal with a field key no input declares fails loud (ghost field)', async () => {
		const bot = await createMockBot({ components: [FeedbackModalButton] });
		const user = apiUser({ id: '779' });
		const raw = bot.actor({ session: false });
		const opener = raw.clickButton('open-feedback', { user, allowSyntheticSource: true });
		await opener.untilModal();
		expect(() => raw.submitModal('feedback-modal', { bogus: 'x' }, { user })).toThrow(
			/field\(s\) "bogus" are not inputs on the displayed modal.+Known inputs: rating/s,
		);
		await raw.submitModal('feedback-modal', { rating: '5' }, { user });
		await opener;
		await bot.close();
	});
});

describe('the actor carries the whole identity', () => {
	test('a panel-clicking actor keeps its session instead of dropping to an un-sessioned dispatcher', async () => {
		const { world, guild, actor: seeded, channel } = seedGuildFixture('actor-synth');

		const bot = await createMockBot({ components: [ConfirmButton], world });
		const actor = bot.actor({
			user: seeded.user,
			guildId: guild.id,
			channel,
			allowSyntheticSource: true,
			locale: 'es-ES',
		});

		const result = await actor.clickButton('confirm');

		expect(rendered(result).get.message().content).toBe('Confirmed!');
		// the identity came from the actor binding — the whole point, since reaching this path used to mean
		// dropping to an un-sessioned dispatcher and restating user/guild/channel by hand
		expect(bot.restCalls()).not.toHaveLength(0);
		await bot.close();
	});

	test('locale binds once instead of at every call', async () => {
		const { world, guild, actor: seeded, channel } = seedGuildFixture('actor-locale');
		const seen: string[] = [];

		@Declare({ name: 'lang', description: 'reports its locale' })
		class Lang extends Command {
			async run(ctx: CommandContext) {
				seen.push(ctx.interaction?.locale ?? 'none');
				await ctx.write({ content: 'ok' });
			}
		}

		const bot = await createMockBot({ commands: [Lang], world });
		const actor = bot.actor({ user: seeded.user, guildId: guild.id, channel, locale: 'es-ES' });

		await actor.slash({ name: 'lang' });
		await actor.slash({ name: 'lang' });

		expect(seen).toEqual(['es-ES', 'es-ES']);
		await bot.close();
	});
});
