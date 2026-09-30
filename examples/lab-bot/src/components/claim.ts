import { ComponentCommand, type ComponentContext, MessageFlags } from 'seyfert';

export default class Claim extends ComponentCommand {
	componentType = 'Button' as const;
	customId = 'support:claim';

	override async run(ctx: ComponentContext<'Button'>) {
		const guildId = ctx.guildId;
		const staffRole = guildId && (await ctx.client.roles.list(guildId)).find(role => role.name === 'Staff');
		if (!staffRole || !ctx.member?.roles.keys.includes(staffRole.id)) {
			await ctx.write({ content: 'Only Staff can claim requests.', flags: MessageFlags.Ephemeral });
			return;
		}
		await ctx.update({
			content: `${ctx.message.content}\nClaimed by ${ctx.author.username}.`,
			components: [],
		});
	}
}
