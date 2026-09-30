import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	createStringOption,
	Declare,
	Group,
	Groups,
	Label,
	Modal,
	Options,
	StringSelectMenu,
	StringSelectOption,
	SubCommand,
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { expect, test } from 'vitest';
import { createMockBot } from '../../src';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

function form(): Modal {
	return new Modal()
		.setCustomId('source-form')
		.setTitle('Source form')
		.setComponents([
			new Label().setLabel('Answer').setComponent(new TextInput({ custom_id: 'answer', style: TextInputStyle.Short })),
		]);
}

function fixture(tag: string) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: `${tag}-guild`, everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const member = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-user` }) });
	return { world, guild, channel, member };
}

test('slash modal source distinguishes grouped subcommands and keeps normalized options', async () => {
	@Declare({ name: 'first', description: 'Open the first form' })
	@Group('settings')
	@Options({
		z: createStringOption({ description: 'Last', required: true }),
		a: createStringOption({ description: 'First', required: true }),
	})
	class First extends SubCommand {
		async run(ctx: CommandContext) {
			await ctx.interaction.modal(form(), { waitFor: 2000 });
		}
	}
	@Declare({ name: 'second', description: 'Open the second form' })
	@Group('settings')
	class Second extends SubCommand {
		async run(ctx: CommandContext) {
			await ctx.interaction.modal(form(), { waitFor: 2000 });
		}
	}
	@Declare({ name: 'source-command', description: 'Source command' })
	@Groups({ settings: { defaultDescription: 'Settings' } })
	@Options([First, Second])
	class SourceCommand extends Command {}

	const { world, guild, channel, member } = fixture('slash-source');
	const bot = await createMockBot({ commands: [SourceCommand], world });
	try {
		const actor = bot.actor({ user: member.user, guildId: guild.id, channel });
		await actor.slash({
			name: 'source-command',
			group: 'settings',
			subcommand: 'first',
			options: { z: 'last', a: 'first' },
		});
		const first = bot.pendingInteractions().modals[0]?.source;
		expect(first).toEqual({
			channelId: channel.id,
			commandName: 'source-command',
			group: 'settings',
			subcommand: 'first',
			options: { a: 'first', z: 'last' },
		});
		expect(JSON.stringify(first?.options)).toBe('{"a":"first","z":"last"}');
		await actor.submitModal('source-form', { answer: 'ok' });
		await actor.slash({ name: 'source-command', group: 'settings', subcommand: 'second' });
		const second = bot.pendingInteractions().modals[0]?.source;
		expect(second).toEqual({
			channelId: channel.id,
			commandName: 'source-command',
			group: 'settings',
			subcommand: 'second',
			options: {},
		});
		await actor.submitModal('source-form', { answer: 'ok' });
	} finally {
		await bot.close();
	}
});

test('component modal sources distinguish source messages and selected values', async () => {
	const components = [
		new ActionRow<Button>().setComponents([
			new Button().setCustomId('same-opener').setLabel('Open').setStyle(ButtonStyle.Primary),
		]),
		new ActionRow<StringSelectMenu>().setComponents([
			new StringSelectMenu()
				.setCustomId('same-select')
				.setOptions([
					new StringSelectOption().setLabel('One').setValue('one'),
					new StringSelectOption().setLabel('Two').setValue('two'),
				]),
		]),
	];
	@Declare({ name: 'two-panels', description: 'Post two panels' })
	class TwoPanels extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'First panel', components });
			await ctx.interaction.followup({ content: 'Second panel', components });
		}
	}
	class OpenButton extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'same-opener';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.interaction.modal(form(), { waitFor: 2000 });
		}
	}
	class OpenSelect extends ComponentCommand {
		componentType = 'StringSelect' as const;
		customId = 'same-select';
		async run(ctx: ComponentContext<'StringSelect'>) {
			await ctx.interaction.modal(form(), { waitFor: 2000 });
		}
	}
	const { world, guild, channel, member } = fixture('component-source');
	const bot = await createMockBot({ commands: [TwoPanels], components: [OpenButton, OpenSelect], world });
	try {
		const actor = bot.actor({ user: member.user, guildId: guild.id, channel });
		await actor.slash({ name: 'two-panels' });
		const [first, second] = bot.conversation({ userId: member.user.id, channelId: channel.id }).messages;
		const button = { channelId: channel.id, customId: 'same-opener' };
		const select = { channelId: channel.id, customId: 'same-select' };
		const openers = [
			{
				open: () => actor.clickButton('same-opener', { source: first.id }),
				source: { ...button, messageId: first.id },
			},
			{
				open: () => actor.clickButton('same-opener', { source: second.id }),
				source: { ...button, messageId: second.id },
			},
			{
				open: () => actor.selectMenu('same-select', ['one'], { source: first.id }),
				source: { ...select, messageId: first.id, values: ['one'] },
			},
			{
				open: () => actor.selectMenu('same-select', ['two'], { source: first.id }),
				source: { ...select, messageId: first.id, values: ['two'] },
			},
		];
		for (const { open, source } of openers) {
			await open();
			expect(bot.pendingInteractions().modals[0]?.source).toEqual(source);
			await actor.submitModal('source-form', { answer: 'ok' });
		}
	} finally {
		await bot.close();
	}
});
