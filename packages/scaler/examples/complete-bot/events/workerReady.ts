import { createEvent } from 'seyfert';

export default createEvent({
	data: { name: 'workerReady' },
	run(user, client) {
		client.logger.info(`Worker ${client.workerId} ready as ${user.username}`);
	},
});
