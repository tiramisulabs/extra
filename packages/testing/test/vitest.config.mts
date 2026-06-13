import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		globalSetup: './test/global-setup.mts',
		isolate: false,
	},
});
