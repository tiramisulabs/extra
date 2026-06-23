import { resetMockIds } from './id';

interface RunnerHooks {
	beforeEach?: (fn: () => void) => void;
}

/**
 * One-import test bootstrap. Call it from your runner's setup file (vitest `setupFiles`, jest
 * `setupFilesAfterEach`) to auto-reset the deterministic id sequence before every test — removing cross-test
 * id bleed (the most common isolation footgun) without per-file boilerplate.
 *
 * Runner-agnostic: it uses the global `beforeEach` hook the runner installs. If no hook is available it is a
 * no-op (so importing it outside a runner is harmless).
 *
 * ```ts
 * // test/setup.ts  (vitest: setupFiles: ['./test/setup.ts'])
 * import { setupSlipherTesting } from '@slipher/testing';
 * setupSlipherTesting();
 * ```
 */
export function setupSlipherTesting(): void {
	const beforeEach = (globalThis as RunnerHooks).beforeEach;
	if (typeof beforeEach === 'function') {
		beforeEach(() => resetMockIds());
	}
}
