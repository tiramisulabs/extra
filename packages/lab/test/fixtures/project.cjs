const { createRequire } = require('node:module');
const testingRequire = createRequire(require.resolve('@slipher/testing'));
const { createMockBot } = testingRequire('@slipher/testing');
const {
	ActionRow,
	Button,
	Command,
	ComponentCommand,
	createStringOption,
	Declare,
	Label,
	MessageFlags,
	Modal,
	Options,
	SubCommand,
	StringSelectMenu,
	StringSelectOption,
	TextInput,
} = testingRequire('seyfert');
const { ButtonStyle, TextInputStyle } = testingRequire('seyfert/lib/types');
const { defineProject, defineScenario, param } = require('../../lib/index.js');
let liveBot;
const dynamicChannelId = '888888888888888888';

class Flow extends Command {
	async run(ctx) {
		const row = new ActionRow().setComponents([
			new Button().setCustomId('open').setLabel('Open').setStyle(ButtonStyle.Primary),
		]);
		await ctx.write({ content: 'Panel', components: [row.toJSON()] });
		const message = await ctx.fetchResponse();
		message.createComponentCollector().run('open', async interaction => {
			const modal = new Modal()
				.setCustomId('answer')
				.setTitle('Answer')
				.setComponents([
					new Label()
						.setLabel('Value')
						.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
				]);
			const submit = await interaction.modal(modal, { waitFor: 2000 });
			if (submit) await submit.write({ content: `saved:${submit.getInputValue('value')}` });
		});
	}
}
const FlowCommand = Declare({ name: 'flow', description: 'Run flow' })(Flow);

class ShortFlow extends Command {
	async run(ctx) {
		const row = new ActionRow().setComponents([
			new Button().setCustomId('open-short').setLabel('Open short').setStyle(ButtonStyle.Primary),
		]);
		await ctx.write({ content: 'Short panel', components: [row.toJSON()] });
		const message = await ctx.fetchResponse();
		message.createComponentCollector().run('open-short', async interaction => {
			const modal = new Modal()
				.setCustomId('short-answer')
				.setTitle('Short answer')
				.setComponents([
					new Label()
						.setLabel('Value')
						.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
				]);
			await interaction.modal(modal, { waitFor: 30 });
		});
	}
}
const ShortFlowCommand = Declare({ name: 'short-flow', description: 'Run short flow' })(ShortFlow);

class PickModal extends Command {
	async run(ctx) {
		const modal = new Modal()
			.setCustomId('pick-modal')
			.setTitle('Pick')
			.setComponents([
				new Label().setLabel('Reasons').setComponent(
					new StringSelectMenu()
						.setCustomId('reasons')
						.setValuesLength({ min: 2, max: 2 })
						.setOptions([
							new StringSelectOption().setLabel('Spam').setValue('spam').setDefault(true),
							new StringSelectOption().setLabel('Abuse').setValue('abuse'),
							new StringSelectOption().setLabel('Other').setValue('other'),
						]),
				),
			]);
		const submit = await ctx.interaction.modal(modal, { waitFor: 2000 });
		if (submit) await submit.write({ content: `reasons:${submit.getInputValue('reasons').join(',')}` });
	}
}
const PickModalCommand = Declare({ name: 'pick-modal', description: 'Pick in modal' })(PickModal);

class NeedsRole extends Command {
	async onPermissionsFail(ctx) {
		await ctx.write({ content: 'missing member perms' });
	}
	async run(ctx) {
		await ctx.write({ content: 'member ok' });
	}
}
const NeedsRoleCommand = Declare({
	name: 'needs-role',
	description: 'Needs BanMembers',
	defaultMemberPermissions: ['BanMembers'],
})(NeedsRole);
class PrivatePanel extends Command {
	async run(ctx) {
		const row = new ActionRow().setComponents([
			new Button().setCustomId('private').setLabel('Private').setStyle(ButtonStyle.Primary),
		]);
		await ctx.write({ content: 'private panel', components: [row.toJSON()], flags: MessageFlags.Ephemeral });
	}
}
const PrivatePanelCommand = Declare({ name: 'private-panel', description: 'Private panel' })(PrivatePanel);
class OpenSupport extends SubCommand {
	async run(ctx) {
		await ctx.write({ content: 'support opened' });
	}
}
const OpenSupportCommand = Declare({ name: 'open', description: 'Open support' })(OpenSupport);
const topicOptions = { topic: createStringOption({ description: 'Topic', required: true }) };
class FormSupport extends SubCommand {
	async run(ctx) {
		const modal = new Modal()
			.setCustomId('support-form')
			.setTitle('Support form')
			.setComponents([
				new Label().setLabel('Value').setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
			]);
		await ctx.interaction.modal(modal, { waitFor: 2000 });
	}
}
const FormSupportCommand = Declare({ name: 'form', description: 'Support form' })(Options(topicOptions)(FormSupport));
class OtherSupport extends SubCommand {
	async run(ctx) {
		await ctx.write({ content: 'other support' });
	}
}
const OtherSupportCommand = Declare({ name: 'other', description: 'Other support' })(OtherSupport);
class Support extends Command {}
const SupportCommand = Declare({ name: 'support', description: 'Support' })(
	Options([OpenSupportCommand, FormSupportCommand, OtherSupportCommand])(Support),
);
class CreateChannel extends Command {
	async run(ctx) {
		const guildId = liveBot.world.all.guild()[0].id;
		await liveBot.seed(world => world.registerChannel(guildId, { id: dynamicChannelId, name: 'new-channel' }));
		await ctx.write({ content: 'channel created' });
	}
}
const CreateChannelCommand = Declare({ name: 'create-channel', description: 'Create channel' })(CreateChannel);
class PrivateButton extends ComponentCommand {
	componentType = 'Button';
	customId = 'private';
	async run(ctx) {
		await ctx.write({ content: 'clicked:private' });
	}
}

const scenario = defineScenario({
	id: 'flow',
	version: 1,
	title: 'Flow',
	params: { label: param.string({ default: 'Panel' }) },
	world(w) {
		const guild = w.guild('guild', {
			name: 'Lab',
			everyonePermissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
		});
		const access = w.role('access', guild, { permissions: ['ViewChannel'] });
		w.role('ban', guild, { permissions: ['BanMembers'] });
		w.channel('channel', guild, {
			name: 'general',
			overwrites: [
				{ id: guild, type: 'role', deny: ['ViewChannel'] },
				{ id: access, type: 'role', allow: ['ViewChannel'] },
			],
		});
		w.channel('other-channel', guild, { name: 'other' });
		w.member('alice', guild, { roles: [access] });
		w.member('bob', guild, { roles: [access] });
		w.member('carol', guild);
	},
	actors: refs => ({
		alice: { userId: 'alice', guildId: 'guild', channelId: 'channel' },
		bob: { userId: refs.bob, guildId: refs.guild, channelId: refs.channel },
		carol: { userId: refs.carol, guildId: refs.guild, channelId: refs.channel },
	}),
});
const project = defineProject({
	name: 'fixture',
	scenarios: [scenario],
	inspect: { fixture: ctx => ({ label: ctx.params.label }) },
	bot: async ({ world }) => {
		liveBot = await createMockBot({
			world,
			commands: [
				FlowCommand,
				ShortFlowCommand,
				PickModalCommand,
				NeedsRoleCommand,
				PrivatePanelCommand,
				SupportCommand,
				CreateChannelCommand,
			],
			components: [PrivateButton],
		});
		return liveBot;
	},
});
module.exports = { project };
