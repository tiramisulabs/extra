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
	UserSelectMenu,
	RadioGroup,
	CheckboxGroup,
	Checkbox,
	FileUpload,
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
		const select = new ActionRow().setComponents([
			new StringSelectMenu()
				.setCustomId('panel-choice')
				.setOptions([new StringSelectOption().setLabel('One').setValue('one')]),
		]);
		await ctx.write({ content: 'Panel', components: [row.toJSON(), select.toJSON()] });
		const message = await ctx.fetchResponse();
		const collector = message.createComponentCollector();
		collector.run('panel-choice', async interaction => {
			const source = liveBot
				.inspectChannel(message.channelId)
				.messages.find(item => item.id === interaction.message.id);
			await interaction.write({ content: `picked:${source.sequence}` });
		});
		collector.run('open', async interaction => {
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

class ReadFile extends Command {
	async run(ctx) {
		const form = new Modal()
			.setCustomId('read-file')
			.setTitle('Read file')
			.setComponents([new Label().setLabel('File').setComponent(new FileUpload({ custom_id: 'file' }))]);
		const submit = await ctx.interaction.modal(form, { waitFor: 120000 });
		if (!submit) return;
		const file = submit.getFiles('file')[0];
		const response = await fetch(file.url);
		if (!response.ok) throw new Error(`File fetch failed: ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		await submit.write({ content: `bytes:${bytes.toString('base64')}` });
	}
}
const ReadFileCommand = Declare({ name: 'read-file', description: 'Read uploaded bytes' })(ReadFile);

class AdvancedForm extends Command {
	async run(ctx) {
		const form = new Modal()
			.setCustomId('advanced-form')
			.setTitle('Advanced form')
			.setComponents([
				new Label().setLabel('User').setComponent(new UserSelectMenu().setCustomId('who')),
				new Label().setLabel('Radio').setComponent(
					new RadioGroup({
						custom_id: 'radio',
						options: [
							{ label: 'A', value: 'a' },
							{ label: 'B', value: 'b' },
						],
					}),
				),
				new Label().setLabel('Checks').setComponent(
					new CheckboxGroup({
						custom_id: 'checks',
						options: [
							{ label: 'A', value: 'a' },
							{ label: 'B', value: 'b' },
						],
					}),
				),
				new Label().setLabel('Confirm').setComponent(new Checkbox({ custom_id: 'confirm' })),
				new Label().setLabel('Files').setComponent(new FileUpload({ custom_id: 'files', required: false })),
			]);
		const submit = await ctx.interaction.modal(form, { waitFor: 120000 });
		if (submit)
			await submit.write({
				content: JSON.stringify({
					who: submit.getUsers('who')[0].id,
					radio: submit.getRadioValues('radio'),
					checks: submit.getCheckboxValues('checks'),
					confirm: submit.getCheckbox('confirm'),
					files: submit.getFiles('files').map(file => [file.filename, file.size, file.contentType]),
				}),
			});
	}
}
const AdvancedFormCommand = Declare({ name: 'advanced-form', description: 'Advanced fields' })(AdvancedForm);

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
				ReadFileCommand,
				AdvancedFormCommand,
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
