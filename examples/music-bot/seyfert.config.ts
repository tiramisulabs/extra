import { config, GatewayIntentBits } from 'seyfert';

const token = process.env.TOKEN;

if (!token) throw new Error('TOKEN is required.');

export default config.bot({
	token,
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates,
	],
	locations: {
		base: 'src',
		commands: 'commands',
		events: 'events',
	},
});
