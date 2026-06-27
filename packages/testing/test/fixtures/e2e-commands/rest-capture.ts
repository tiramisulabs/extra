import { Command, type CommandContext, Declare, MessageFlags } from 'seyfert';

@Declare({ name: 'dir-broken-video', description: 'Sends a missing attachment reference through proxy REST' })
export default class DirBrokenVideo extends Command {
	async run(ctx: CommandContext) {
		await ctx.proxy.channels(ctx.channelId).messages.post({
			body: {
				flags: MessageFlags.IsComponentsV2,
				components: [
					{
						type: 12,
						items: [{ media: { url: 'attachment://vid7.mp4', content_type: 'video/mp4' } }],
					},
				],
			},
		});
	}
}
