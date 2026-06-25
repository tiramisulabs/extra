import { type CommandContext, Declare, SubCommand } from 'seyfert';
import { totalItems } from '../catalog-source';

@Declare({ name: 'list', description: 'List catalog items' })
export default class CatalogList extends SubCommand {
	async run(ctx: CommandContext) {
		await ctx.write({ content: `total: ${totalItems()}` });
	}
}
