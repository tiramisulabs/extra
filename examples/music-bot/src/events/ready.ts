import { createEvent } from 'seyfert';

export default createEvent({
	data: { name: 'botReady', once: true },
	async run(user, client) {
		client.logger.info(`Logged in as ${user.username}.`);
		await client.uploadCommands({ cachePath: './commands.json' });
	},
});
