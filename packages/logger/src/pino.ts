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

export function pinoAdapter(target: PinoLoggerLike, appliedBindings: LogBindings = {}): LoggerAdapter {
	const child = target.child;
	const flush = target.flush;

	return {
		write(entry) {
			const method = target[entry.level] ?? target.info;
			if (!method) return;
			method.call(
				target,
				stripUndefined({ ...unappliedBindings(entry.bindings, appliedBindings), ...entry.data }),
				entry.message,
			);
		},
		child: child
			? bindings => pinoAdapter(child.call(target, bindings), { ...appliedBindings, ...bindings })
			: undefined,
		flush: flush ? () => flush.call(target) : undefined,
	};
}

function unappliedBindings(bindings: LogBindings, appliedBindings: LogBindings): LogBindings {
	const next: LogBindings = {};
	for (const [key, value] of Object.entries(bindings)) {
		if (Object.hasOwn(appliedBindings, key) && Object.is(appliedBindings[key], value)) continue;
		next[key] = value;
	}
	return next;
}
