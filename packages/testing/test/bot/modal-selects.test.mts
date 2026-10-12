import {
	ChannelSelectMenu,
	Checkbox,
	CheckboxGroup,
	Command,
	type CommandContext,
	Declare,
	FileUpload,
	Label,
	MentionableSelectMenu,
	Modal,
	RadioGroup,
	RoleSelectMenu,
	StringSelectMenu,
	StringSelectOption,
	UserSelectMenu,
} from 'seyfert';
import { describe, expect, test } from 'vitest';
import { apiUser, mockWorld } from '../../src/bot';
import { createMockBot } from '../../src/bot/bot';
import { modalSelect } from '../../src/bot/interactions';

// A modal can carry select menus (string/user/role/channel/mentionable), not just text inputs. A `string[]` field is
// a string select (getInputValue returns the ids); modalSelect(values, kind) is an entity select whose data.resolved
// is auto-built so getUsers/getRoles/getChannels/getMentionables resolve.
describe('modal select menus', () => {
	test('a string select fills via a string[] and getInputValue returns the selected ids', async () => {
		@Declare({ name: 'pick', description: 'Pick from a string select in a modal' })
		class PickCommand extends Command {
			async run(ctx: CommandContext) {
				const modal = new Modal()
					.setCustomId('pick-modal')
					.setTitle('Pick')
					.setComponents([
						new Label()
							.setLabel('Reason')
							.setComponent(
								new StringSelectMenu()
									.setCustomId('reasons')
									.setOptions([
										new StringSelectOption().setLabel('Spam').setValue('spam'),
										new StringSelectOption().setLabel('Abuse').setValue('abuse'),
									]),
							),
					]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
				if (!submit) return;
				const values = submit.getInputValue('reasons') as unknown as string[];
				await submit.write({ content: `reasons:${values.join(',')}` });
			}
		}

		const bot = await createMockBot({ commands: [PickCommand] });
		await bot.slash({ name: 'pick' });
		const result = await bot.submitModal('pick-modal', { reasons: ['spam', 'abuse'] });
		expect(result.content).toBe('reasons:spam,abuse');
		await bot.close();
	});

	test('a user select fills via modalSelect and getUsers resolves the chosen users', async () => {
		@Declare({ name: 'assign', description: 'Assign via a user select in a modal' })
		class AssignCommand extends Command {
			async run(ctx: CommandContext) {
				const modal = new Modal()
					.setCustomId('assign-modal')
					.setTitle('Assign')
					.setComponents([new Label().setLabel('Assignee').setComponent(new UserSelectMenu().setCustomId('who'))]);
				const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
				if (!submit) return;
				const users = submit.getUsers('who') ?? [];
				await submit.write({ content: `users:${users.map(u => u.id).join(',')}` });
			}
		}

		const bot = await createMockBot({ commands: [AssignCommand] });
		await bot.slash({ name: 'assign' });
		const result = await bot.submitModal('assign-modal', {
			who: modalSelect(['user-1', 'user-2'], 'user'),
		});
		expect(result.content).toBe('users:user-1,user-2');
		await bot.close();
	});
});

describe('rendered modal field types', () => {
	test('plain IDs resolve entity selects from the rendered definition and seeded data', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'modal-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'modal-actor' }) });
		const target = world.registerMember(guild.id, {
			user: apiUser({ id: 'modal-target', username: 'Chosen user' }),
			nick: 'Chosen nick',
		});
		const role = world.registerRole(guild.id, { id: 'modal-role', name: 'Chosen role' });
		const channel = world.registerChannel(guild.id, { id: 'modal-channel', name: 'chosen-channel' });
		@Declare({ name: 'entities', description: 'Entity form' })
		class Entities extends Command {
			async run(ctx: CommandContext) {
				const form = new Modal()
					.setCustomId('entities-form')
					.setTitle('Entities')
					.setComponents([
						new Label().setLabel('User').setComponent(new UserSelectMenu().setCustomId('who')),
						new Label().setLabel('Role').setComponent(new RoleSelectMenu().setCustomId('role')),
						new Label().setLabel('Channel').setComponent(new ChannelSelectMenu().setCustomId('where')),
						new Label().setLabel('Mention').setComponent(new MentionableSelectMenu().setCustomId('mention')),
					]);
				const submit = await ctx.interaction.modal(form, { waitFor: 30_000 });
				if (!submit) return;
				await submit.write({
					content: [
						submit.getUsers('who')?.[0].username,
						submit.getRoles('role')?.[0].name,
						submit.getChannels('where')?.[0].id,
						submit.getMentionables('mention')?.[0].id,
					].join('|'),
				});
			}
		}
		const bot = await createMockBot({ world, commands: [Entities] });
		await bot.slash({ name: 'entities', guildId: guild.id, channel, user: actor.user });
		const result = await bot.submitModal('entities-form', {
			who: [target.user.id],
			role: [role.id],
			where: [channel.id],
			mention: [role.id],
		});
		expect(result.content).toBe(`Chosen user|Chosen role|${channel.id}|${role.id}`);
		await bot.close();
	});
	test('radios, checkbox groups, unchecked booleans and empty file uploads preserve their wire types', async () => {
		@Declare({ name: 'choices', description: 'Choices form' })
		class Choices extends Command {
			async run(ctx: CommandContext) {
				const form = new Modal()
					.setCustomId('choices-form')
					.setTitle('Choices')
					.setComponents([
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
				const submit = await ctx.interaction.modal(form, { waitFor: 30_000 });
				if (!submit) return;
				await submit.write({
					content: JSON.stringify({
						radio: submit.getRadioValues('radio', true),
						checks: submit.getCheckboxValues('checks', true),
						confirm: submit.getCheckbox('confirm', true),
						files: submit.getFiles('files', true),
					}),
				});
			}
		}
		const bot = await createMockBot({ commands: [Choices] });
		await bot.slash({ name: 'choices' });
		const result = await bot.submitModal('choices-form', { radio: 'b', checks: ['a'], confirm: false, files: [] });
		expect(JSON.parse(result.content!)).toEqual({ radio: 'b', checks: ['a'], confirm: false, files: [] });
		await bot.close();
	});
});
