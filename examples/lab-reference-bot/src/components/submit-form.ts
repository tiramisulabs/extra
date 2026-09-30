import { ActionRow, Button, ButtonStyle, MessageFlags, ModalCommand, type ModalContext } from 'seyfert';

export default class SubmitForm extends ModalCommand {
	customId = /^support:submit:(question|bug)$/;

	override async run(ctx: ModalContext) {
		const guildId = ctx.guildId;
		if (!guildId) {
			await ctx.write({ content: 'Use this form in a server.', flags: MessageFlags.Ephemeral });
			return;
		}

		const staffChannel = (await ctx.client.guilds.channels.list(guildId)).find(
			channel => channel.isNamed() && channel.name === 'staff',
		);
		const requesterRole = (await ctx.client.roles.list(guildId)).find(role => role.name === 'Requester');
		if (!staffChannel || !requesterRole) {
			await ctx.write({
				content: 'Support is not configured: the #staff channel and Requester role are required.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const topic = ctx.customId.split(':')[2];
		const details = ctx.getInputValue('details', true);
		await ctx.client.messages.write(staffChannel.id, {
			content: `Support request from ${ctx.author.username} (${ctx.author.id}) · ${topic}\n${details}`,
			allowed_mentions: { parse: [] },
			components: [
				new ActionRow<Button>().setComponents([
					new Button().setCustomId('support:claim').setLabel('Claim').setStyle(ButtonStyle.Secondary),
				]),
			],
		});

		try {
			await ctx.client.members.addRole(guildId, ctx.author.id, requesterRole.id);
			await ctx.write({ content: 'Request sent to staff.', flags: MessageFlags.Ephemeral });
		} catch {
			await ctx.write({
				content:
					'Request sent to staff, but I could not assign the Requester role. Check my Manage Roles permission and role position.',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
