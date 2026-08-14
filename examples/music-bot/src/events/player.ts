import { createEvent } from 'seyfert';

export default [
	createEvent({
		data: { name: 'playerTrackStart' },
		run(player, item, client) {
			client.logger.info(`Started "${item.track.title}" in guild ${player.guildId}.`);
		},
	}),
	createEvent({
		data: { name: 'playerTrackEnd' },
		run(player, item, reason, client) {
			client.logger.info(`Ended "${item.track.title}" in guild ${player.guildId}: ${reason}.`);
		},
	}),
	createEvent({
		data: { name: 'playerTrackError' },
		run(player, item, error, client) {
			client.logger.error(`Playback failed for "${item.track.title}" in guild ${player.guildId}.`, error);
		},
	}),
];
