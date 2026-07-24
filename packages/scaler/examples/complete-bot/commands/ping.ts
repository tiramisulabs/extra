import { Command, type CommandContext, Declare } from 'seyfert';

@Declare({ name: 'ping', description: 'Check whether the bot is online' })
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'Pong!' });
	}
}
