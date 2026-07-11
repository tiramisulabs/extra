import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		fileParallelism: false,
		isolate: false,
		// Type-aware rule-tester builds a full TS program against seyfert's .d.ts on the
		// first case of each file; that cold-start exceeds the 5s default on slower CI
		// runners (warm cases run in ~20ms).
		testTimeout: 30_000,
	},
});
