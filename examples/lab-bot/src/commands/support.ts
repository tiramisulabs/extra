import { Command, type CommandContext, Declare, Label, Modal, TextInput, TextInputStyle } from 'seyfert';

@Declare({ name: 'support', description: 'Ask the staff for help' })
export default class Support extends Command {
	override async run(ctx: CommandContext) {
		await ctx.modal(
			new Modal()
				.setCustomId('support:form')
				.setTitle('Support request')
				.setComponents([
					new Label()
						.setLabel('What do you need?')
						.setComponent(
							new TextInput()
								.setCustomId('details')
								.setStyle(TextInputStyle.Paragraph)
								.setLength({ min: 1, max: 500 })
								.setRequired(),
						),
				]),
		);
	}
}
