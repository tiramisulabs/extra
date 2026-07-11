import { Command, type CommandContext, Declare } from 'seyfert';
import { fetchBalance } from './external-service';

@Declare({ name: 'balance', description: 'Shows balance' })
export class BalanceCommand extends Command {
	async run(ctx: CommandContext) {
		const balance = fetchBalance(ctx.author.id);
		await ctx.write({ content: `balance: ${balance}` });
	}
}
