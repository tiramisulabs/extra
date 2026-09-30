import type { Session, SessionEvent } from './index';

export const LAB_VERSION: string = require('../package.json').version;

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
