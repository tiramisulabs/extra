import type { PlayerQueueItem } from '@slipher/player';
import { Command, type CommandContext, createStringOption, Declare, Options } from 'seyfert';
import { prepareYoutubeTrack } from '../../youtube-provider.js';

const options = {
	source: createStringOption({
		description: 'YouTube video URL to play.',
		required: true,
	}),
};

@Declare({
	name: 'play',
	description: 'Play audio in your current voice channel.',
})
@Options(options)
export default class PlayCommand extends Command {
	override async run(ctx: CommandContext<typeof options>) {
		if (!ctx.inGuild()) {
			await ctx.write({
				content: 'This command can only be used in a server.',
			});
			return;
		}
		if (!ctx.member) {
			await ctx.write({ content: 'Could not resolve your server member.' });
			return;
		}

		const voiceState = await ctx.member.voice().catch(() => null);
		if (!voiceState?.channelId) {
			await ctx.write({ content: 'Join a voice channel first.' });
			return;
		}

		await ctx.deferReply();

		try {
			const signal = AbortSignal.timeout(45_000);
			const result = await ctx.player.resolve(ctx.options.source, {
				provider: 'youtube',
				signal,
			});
			if (result.kind !== 'track') {
				await ctx.editResponse({
					content: 'YouTube did not return a playable video.',
				});
				return;
			}
			const preparation = await prepareYoutubeTrack(result.track, signal);

			let item: PlayerQueueItem;
			try {
				const connection = await ctx.voice.connect({
					guildId: ctx.guildId,
					channelId: voiceState.channelId,
					selfDeaf: true,
				});
				const guildPlayer = ctx.player.create(connection);
				item = await guildPlayer.enqueue(result.track);
			} catch (error) {
				await preparation.discard();
				throw error;
			}

			await ctx.editResponse({ content: `Queued **${item.track.title}**.` });
		} catch (error) {
			ctx.client.logger.error('Could not play the requested media.', error);
			await ctx.editResponse({
				content: 'Could not play that YouTube URL.',
			});
		}
	}
}
