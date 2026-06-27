import { Command, type CommandContext, Declare, Label, Modal, TextInput } from 'seyfert';
import { TextInputStyle } from 'seyfert/lib/types';

@Declare({ name: 'intake', description: 'Open a modal then echo a field' })
export default class IntakeCommand extends Command {
	async run(ctx: CommandContext) {
		const modal = new Modal()
			.setCustomId('intake-modal')
			.setTitle('Intake')
			.setComponents([
				new Label()
					.setLabel('Reason')
					.setComponent(new TextInput({ custom_id: 'reason', style: TextInputStyle.Short })),
			]);
		const submit = await ctx.interaction.modal(modal, { waitFor: 30_000 });
		if (!submit) return;
		await submit.write({ content: `reason:${submit.getInputValue('reason')}` });
	}
}
