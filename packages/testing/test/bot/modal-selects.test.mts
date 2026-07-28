import {
	Command,
	type CommandContext,
	Declare,
	Label,
	Modal,
	StringSelectMenu,
	StringSelectOption,
	UserSelectMenu,
} from 'seyfert';
import { describe, expect, test } from 'vitest';
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
