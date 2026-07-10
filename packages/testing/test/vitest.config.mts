import { defineConfig } from 'vitest/config';

export default defineConfig({
	oxc: {
		decorator: { emitDecoratorMetadata: true, legacy: true },
	},
	test: {
		fileParallelism: false,
		globalSetup: './test/global-setup.mts',
		isolate: false,
	},
});
