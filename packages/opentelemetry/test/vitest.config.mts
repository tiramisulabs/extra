import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Per-file isolation keeps sticky OTel globals from one suite from
		// poisoning another (e.g. startOwnedSdk needs a bare ProxyTracerProvider).
		// Within a file, globals still stick across tests as before.
		fileParallelism: false,
		isolate: true,
	},
});
