import { defineConfig } from 'vite';

export default defineConfig({
	base: './',
	// The protocol entry is CommonJS from a linked workspace package; pre-bundle it so the dev server can import it.
	optimizeDeps: { include: ['@slipher/lab/protocol'] },
});
