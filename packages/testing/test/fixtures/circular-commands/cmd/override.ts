import { type CommandContext, Declare, SubCommand } from 'seyfert';
import { label } from '../deps/format';
import { describe as describeStore } from '../deps/store';

@Declare({ name: 'override', description: 'Imports submodules directly' })
export default class CircOverride extends SubCommand {
	async run(ctx: CommandContext) {
		await ctx.write({ content: `${describeStore()}|${label('y')}` });
	}
}
