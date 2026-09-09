import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/*.test.mjs'],
		globalSetup: ['./test/global-setup.mjs'],
		fileParallelism: false,
		isolate: false,
		testTimeout: 60_000,
	},
});
