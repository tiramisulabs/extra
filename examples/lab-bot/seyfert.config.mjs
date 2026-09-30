import { config } from 'seyfert';

export default config.bot({
	token: process.env.TOKEN ?? '',
	intents: ['Guilds'],
	locations: {
		base: 'dist/src',
		commands: 'commands',
		components: 'components',
	},
});
