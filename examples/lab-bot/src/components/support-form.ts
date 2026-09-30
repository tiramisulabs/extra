import { ActionRow, Button, ButtonStyle, MessageFlags, ModalCommand, type ModalContext } from 'seyfert';

export default class SupportForm extends ModalCommand {
	customId = 'support:form';

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
				content: 'Support needs a #staff channel and a Requester role.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await ctx.client.messages.write(staffChannel.id, {
			content: `Request from ${ctx.author.username}: ${ctx.getInputValue('details', true)}`,
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
				content: 'Request sent to staff, but I could not assign the Requester role.',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
