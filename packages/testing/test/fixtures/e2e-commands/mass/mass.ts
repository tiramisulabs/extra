import { Command, type CommandContext, Declare } from 'seyfert';

// Folder is `mass/` but the command name is `mass-dm` — exercises the lazy fallback scan path.
@Declare({ name: 'mass-dm', description: 'Mass DM' })
export default class MassCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'mass' });
	}
}
