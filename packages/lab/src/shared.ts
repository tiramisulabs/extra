import type { Checkpoint, Session, SessionEvent } from './index';
import { isPositiveInteger } from './protocol';

export const LAB_VERSION: string = require('../package.json').version;

/** How long each in-process cleanup step (bot close, resources dispose) and a child's exit may take. */
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5000;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Returns `value`, or throws a `TypeError` naming the option when it is not a positive safe integer. */
export function positiveInteger(value: number, name: string): number {
	if (!isPositiveInteger(value)) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

export interface ChildTimeouts {
	startTimeoutMs?: number;
	disposeTimeoutMs?: number;
	rpcTimeoutMs?: number;
}

/** Rejects zero, negative or non-integer timeouts before they reach `setTimeout`. */
export function validateTimeouts(options: ChildTimeouts): void {
	for (const name of ['startTimeoutMs', 'disposeTimeoutMs', 'rpcTimeoutMs'] as const) {
		const value = options[name];
		if (value !== undefined) positiveInteger(value, name);
	}
}

/** Checkpoints replay only on the lab version that recorded them. */
export function assertLabVersion(checkpoint: Pick<Checkpoint, 'labVersion'>): void {
	if (checkpoint.labVersion !== LAB_VERSION)
		throw new Error(`Checkpoint lab version ${checkpoint.labVersion} is not supported (current ${LAB_VERSION})`);
}

type Listener = (event: SessionEvent) => void;

/**
 * Session event fan-out shared by in-process and child sessions. A throwing listener never
 * interrupts delivery: its failure is kept as a diagnostic and reported to the other listeners
 * (failures while handling such a report are only recorded, so reports cannot cascade).
 */
export function createObservers() {
	const listeners = new Set<Listener>();
	const diagnostics: string[] = [];
	const deliver = (listener: Listener, event: SessionEvent): string | undefined => {
		try {
			listener(event);
			return undefined;
		} catch (error) {
			const detail = `Observer failed: ${errorText(error)}`;
			diagnostics.push(detail);
			return detail;
		}
	};
	const emit = (event: SessionEvent): void => {
		const isObserverReport = event.type === 'error' && event.origin === 'observer';
		for (const listener of listeners) {
			const detail = deliver(listener, event);
			if (detail === undefined || isObserverReport) continue;
			for (const other of listeners)
				if (other !== listener) deliver(other, { type: 'error', origin: 'observer', detail });
		}
	};
	const observe: Session['observe'] = listener => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	return { emit, observe, diagnostics };
}
