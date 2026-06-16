/**
 * The exact `toFake` subset seyfert's collector/modal timers need. The mock's async drain yields through the
 * real `setImmediate` captured at module load, so faking `setImmediate` (vitest's default) deadlocks it — fake
 * only `setTimeout`/`clearTimeout`. See {@link MockBot.advanceTime}.
 */
export const FAKE_TIMER_OPTIONS = { toFake: ['setTimeout', 'clearTimeout'] } as const;

/** The minimal fake-timer controller surface this adapter drives — satisfied by vitest's `vi` and jest's. */
export interface FakeTimerController {
	useFakeTimers(options?: { toFake?: readonly string[] }): unknown;
	advanceTimersByTime(ms: number): unknown;
}

/**
 * One-call fake-timer wiring for timed collector/modal tests. Installs the correct `toFake` subset on the
 * runner's clock and returns the `timers` bag `createMockBot` expects, so the two coupled config points
 * collapse into one runner-agnostic call:
 *
 * ```ts
 * const bot = await createMockBot({ commands: [Cmd], timers: withFakeTimers(vi) });
 * // ...dispatch...
 * await bot.advanceTime(60_000);
 * // restore in afterEach: vi.useRealTimers();
 * ```
 */
export function withFakeTimers(vi: FakeTimerController): { advance(ms: number): void } {
	vi.useFakeTimers(FAKE_TIMER_OPTIONS);
	return {
		advance(ms: number) {
			vi.advanceTimersByTime(ms);
		},
	};
}
