import { ComponentCommand, type ComponentContext, MessageFlags } from 'seyfert';

export default class Claim extends ComponentCommand {
	componentType = 'Button' as const;
	customId = 'support:claim';

	override async run(ctx: ComponentContext<'Button'>) {
		const guildId = ctx.guildId;
		if (!guildId) {
			await ctx.write({ content: 'Use this button in a server.', flags: MessageFlags.Ephemeral });
			return;
		}
		const staffRole = (await ctx.client.roles.list(guildId)).find(role => role.name === 'Staff');
		const member = await ctx.client.members.fetch(guildId, ctx.author.id);
		if (!staffRole || !member.roles.keys.includes(staffRole.id)) {
			await ctx.write({ content: 'Only Staff can claim requests.', flags: MessageFlags.Ephemeral });
			return;
		}
		await ctx.update({
			content: `${ctx.message.content}\nClaimed by ${ctx.author.username}.`,
			components: [],
		});
	}
}
