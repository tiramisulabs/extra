import { Command, type CommandContext, Declare } from 'seyfert';

@Declare({ name: 'ping', description: 'Replies pong' })
export default class PingCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'pong' });
	}
}
