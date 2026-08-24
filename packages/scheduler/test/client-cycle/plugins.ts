import { definePlugins } from 'seyfert';
import { memory, scheduler } from '../../src';
import { ActivityStatsTask, GuildLicenseCheckTask } from './tasks';

export default definePlugins(
	scheduler({
		driver: memory(),
		tasks: [ActivityStatsTask, GuildLicenseCheckTask],
	}),
);
