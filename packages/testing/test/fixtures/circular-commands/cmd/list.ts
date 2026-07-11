import { type CommandContext, Declare, SubCommand } from 'seyfert';
import { label } from '../deps/shared';

@Declare({ name: 'list', description: 'Uses the barrel' })
export default class CircList extends SubCommand {
	async run(ctx: CommandContext) {
		await ctx.write({ content: label('x') });
	}
}
