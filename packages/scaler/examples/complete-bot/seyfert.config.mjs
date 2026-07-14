import { config } from 'seyfert';

export default config.bot({
	token: process.env.SEYFERT_WORKER_TOKEN ?? process.env.BOT_TOKEN ?? '',
	applicationId: process.env.BOT_APPLICATION_ID ?? '',
	intents: ['Guilds'],
	locations: {
		base: 'dist',
		commands: 'commands',
		events: 'events',
	},
});
