import {
	ActionRow,
	Button,
	ButtonStyle,
	Command,
	type CommandContext,
	createStringOption,
	Declare,
	MessageFlags,
	Options,
	SubCommand,
} from 'seyfert';

const options = {
	topic: createStringOption({
		description: 'What is this about?',
		required: true,
		choices: [
			{ name: 'Question', value: 'question' },
			{ name: 'Bug', value: 'bug' },
		] as const,
	}),
} as const;

@Declare({ name: 'open', description: 'Open a support request' })
@Options(options)
class OpenSupport extends SubCommand {
	override async run(ctx: CommandContext<typeof options>) {
		if (!ctx.inGuild()) {
			await ctx.write({ content: 'Use this command in a server.' });
			return;
		}

		await ctx.client.messages.write(ctx.channelId, {
			content: `Support topic: ${ctx.options.topic}`,
			components: [
				new ActionRow<Button>().setComponents([
					new Button()
						.setCustomId(`support:open:${ctx.options.topic}`)
						.setLabel('Open form')
						.setStyle(ButtonStyle.Primary),
				]),
			],
		});
		await ctx.write({ content: 'Form ready in this channel.', flags: MessageFlags.Ephemeral });
	}
}

@Declare({ name: 'support', description: 'Support requests' })
@Options([OpenSupport])
export default class Support extends Command {}
