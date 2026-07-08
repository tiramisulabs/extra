import type { TraceSource } from '../options';

/**
 * Installs command/component/modal lifecycle defaults (child spans).
 * Full implementation lands in Task 9; register is a no-op until then.
 */
export function registerInteractionInstrumentation(
	_api: {
		commands: { defaults: (hooks: object, opts?: object) => void };
		components: { defaults: (hooks: object, opts?: object) => void };
		modals: { defaults: (hooks: object, opts?: object) => void };
	},
	_deps: { checkIfShouldTrace: (source: TraceSource) => boolean },
): void {
	// Task 9: api.commands/components/modals.defaults(...)
}
