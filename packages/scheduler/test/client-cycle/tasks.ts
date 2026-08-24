import type { UsingClient } from 'seyfert';
import { Cron, type ScheduledTask } from '../../src';

export class ActivityStatsTask {
	@Cron('0 0 * * *', { id: 'activity-stats' })
	async run(_task: ScheduledTask, client: UsingClient) {
		void client;
	}
}

export class GuildLicenseCheckTask {
	@Cron('0 0 * * *', { id: 'guild-license-check' })
	async run(_task: ScheduledTask, client: UsingClient) {
		void client;
	}
}
