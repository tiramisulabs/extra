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
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { expect, test } from 'vitest';
import { createMockBot } from '../../src';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

function fixture(tag: string) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: `${tag}-guild`, everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const member = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-user` }) });
	return { world, guild, channel, member };
}

function form(): Modal {
	return new Modal()
		.setCustomId('timed-form')
		.setTitle('Timed form')
		.setComponents([
			new Label().setLabel('Answer').setComponent(new TextInput({ custom_id: 'answer', style: TextInputStyle.Short })),
		]);
}

@Declare({ name: 'timed-panel', description: 'Open a timed form' })
class Panel extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({
			content: 'Open the form',
			components: [
				new ActionRow<Button>().setComponents([
					new Button().setCustomId('open-timed-form').setLabel('Open').setStyle(ButtonStyle.Primary),
				]),
			],
		});
	}
}

class OpenForm extends ComponentCommand {
	componentType = 'Button' as const;
	customId = 'open-timed-form';
	async run(ctx: ComponentContext<'Button'>) {
		const submit = await ctx.interaction.modal(form(), { waitFor: 100 });
		if (submit) await submit.write({ content: `Saved ${submit.getInputValue('answer')}` });
	}
}

test('waitFor expiry removes the modal and frees the stateful session for a fresh form', async () => {
	const { world, guild, member, channel } = fixture('timed');
	const bot = await createMockBot({ commands: [Panel], components: [OpenForm], world });
	try {
		const actor = bot.actor({ user: member.user, guildId: guild.id, channel });
		await actor.slash({ name: 'timed-panel' });
		const source = bot.conversation({ userId: member.user.id, channelId: channel.id }).messages[0]?.id;
		expect(source).toBeTruthy();
		await actor.clickButton('open-timed-form', { source });
		const [first] = bot.pendingInteractions().modals;
		expect(first?.interactionId).toBeTruthy();
		await expect(actor.slash({ name: 'timed-panel' })).rejects.toThrow(/already has a pending flow/);
		await new Promise(resolve => setTimeout(resolve, 160));
		expect(bot.pendingInteractions().modals).toEqual([]);
		await expect(actor.submitModal('timed-form', { answer: 'late' })).rejects.toThrow(/not available/);
		await actor.clickButton('open-timed-form', { source });
		const [second] = bot.pendingInteractions().modals;
		expect(second?.interactionId).toBeTruthy();
		expect(second?.interactionId).not.toBe(first?.interactionId);
		const submitted = await actor.submitModal('timed-form', { answer: 'yes' });
		expect(submitted.content).toBe('Saved yes');
		expect(bot.pendingInteractions().modals).toEqual([]);
	} finally {
		await bot.close();
	}
});

test('submission before waitFor expiry keeps the submit result and releases the modal', async () => {
	const { world, guild, member, channel } = fixture('early');
	const bot = await createMockBot({ commands: [Panel], components: [OpenForm], world });
	try {
		const actor = bot.actor({ user: member.user, guildId: guild.id, channel });
		await actor.slash({ name: 'timed-panel' });
		const source = bot.conversation({ userId: member.user.id, channelId: channel.id }).messages[0]?.id;
		await actor.clickButton('open-timed-form', { source });
		const submitted = await actor.submitModal('timed-form', { answer: 'early' });
		expect(submitted.content).toBe('Saved early');
		expect(bot.pendingInteractions().modals).toEqual([]);
	} finally {
		await bot.close();
	}
});

test('an expired modal does not remove the replacement registered for the same user', async () => {
	let opens = 0;
	class ReplaceForm extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'open-timed-form';
		async run(ctx: ComponentContext<'Button'>) {
			opens++;
			void ctx.interaction.modal(form(), { waitFor: opens === 1 ? 100 : 1000 });
		}
	}
	const { world, guild, member, channel } = fixture('replace');
	const bot = await createMockBot({ commands: [Panel], components: [ReplaceForm], world });
	try {
		const actor = bot.actor({ user: member.user, guildId: guild.id, channel });
		await actor.slash({ name: 'timed-panel' });
		const source = bot.conversation({ userId: member.user.id, channelId: channel.id }).messages[0]?.id;
		expect(source).toBeTruthy();
		await actor.clickButton('open-timed-form', { source });
		const firstId = bot.pendingInteractions().modals[0]?.interactionId;
		await actor.clickButton('open-timed-form', { source });
		const secondId = bot.pendingInteractions().modals[0]?.interactionId;
		expect(secondId).toBeTruthy();
		expect(secondId).not.toBe(firstId);
		await new Promise(resolve => setTimeout(resolve, 160));
		expect(bot.pendingInteractions().modals).toMatchObject([{ interactionId: secondId }]);
		await actor.submitModal('timed-form', { answer: 'new' });
		expect(bot.pendingInteractions().modals).toEqual([]);
	} finally {
		await bot.close();
	}
});
