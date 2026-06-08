import type { Awaitable, LogBindings, LoggerAdapter } from './core';
import { stripUndefined } from './utils';

export interface PinoLoggerLike {
	trace?: PinoLogMethod;
	debug?: PinoLogMethod;
	info?: PinoLogMethod;
	warn?: PinoLogMethod;
	error?: PinoLogMethod;
	fatal?: PinoLogMethod;
	child?(bindings: LogBindings): PinoLoggerLike;
	flush?(): Awaitable<void>;
}

export type PinoLogMethod = (payload: Record<string, unknown>, message?: string) => unknown;

export function createPinoAdapter(target: PinoLoggerLike): LoggerAdapter {
	const child = target.child;
	const flush = target.flush;

	return {
		write(entry) {
			const method = target[entry.level] ?? target.info;
			if (!method) return;
			method.call(target, stripUndefined({ ...entry.data }), entry.message);
		},
		child: child ? bindings => createPinoAdapter(child.call(target, bindings)) : undefined,
		flush: flush ? () => flush.call(target) : undefined,
	};
}
