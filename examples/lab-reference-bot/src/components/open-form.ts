import { ComponentCommand, type ComponentContext, Label, Modal, TextInput, TextInputStyle } from 'seyfert';

export default class OpenForm extends ComponentCommand {
	componentType = 'Button' as const;
	customId = /^support:open:(question|bug)$/;

	override async run(ctx: ComponentContext<'Button'>) {
		const topic = ctx.interaction.customId.split(':')[2];
		await ctx.interaction.modal(
			new Modal()
				.setCustomId(`support:submit:${topic}`)
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
