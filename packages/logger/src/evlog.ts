import { createRequire } from 'node:module';

import type { LogData, LogEntry, LoggerAdapter, WritableLogLevel } from './core';
import { getString, stripUndefined } from './utils';

export type EvlogLevel = 'debug' | 'info' | 'warn' | 'error';

type EvlogLogMethod = {
	(tag: string, message: string): void;
	(event: Record<string, unknown>): void;
};

interface EvlogCoreModule {
	log: Record<EvlogLevel, EvlogLogMethod>;
}

const requireFromHere = createRequire(__filename);

export function createEvlogAdapter(): LoggerAdapter {
	assertEvlogInstalled();
	const core = importEvlogCore();

	return {
		async write(entry) {
			if (isEvlogLifecycleEntry(entry)) {
				writeEvlogWideEvent(entry, await core);
				return;
			}

			writeEvlogImmediateEntry(entry, await core);
		},
	};
}

function isEvlogLifecycleEntry(entry: LogEntry): boolean {
	return Number.isFinite(entry.data.durationMs) && typeof entry.data.outcome === 'string';
}

function writeEvlogImmediateEntry(entry: LogEntry, core: EvlogCoreModule): void {
	const level = toEvlogLevel(entry.level);
	const tag = getEvlogTag(entry);
	const message = entry.message ?? completedMessage(tag);

	// `name`/`source` become the evlog tag (the `[bracket]`), never plain fields. The
	// remaining fields decide between evlog's clean tagged form and its object form.
	const extra = stripUndefined({ ...entry.bindings, ...entry.data });
	delete extra.name;
	delete extra._source;
	if (entry.level !== level) extra.level = entry.level;

	if (Object.keys(extra).length === 0) {
		core.log[level](tag, message);
		return;
	}

	// Object form renders its `[bracket]` from the event's `service`; set it to the
	// derived tag so the bracket matches the tagged form instead of evlog's default.
	core.log[level]({ service: tag, message, ...extra });
}

function writeEvlogWideEvent(entry: LogEntry, core: EvlogCoreModule): void {
	const level = toEvlogLevel(entry.level);
	const message = entry.message ?? completedMessage(getString(entry.data.kind) ?? 'event');

	// Emit via the object form (not createLogger) so evlog does not stamp its own
	// createLogger -> emit stopwatch as `duration` ("in 0ms"); our real elapsed time is
	// already in the `durationMs` field. The `[bracket]` comes from `service`, set to the
	// derived tag (source ?? name ?? 'app') — same ordering as the console adapter and the
	// immediate path — and consumed here so it is not also a plain field.
	const fields = stripUndefined({ ...entry.bindings, ...entry.data });
	delete fields.name;
	delete fields._source;
	const payload: LogData = stripUndefined({
		service: getEvlogTag(entry),
		...fields,
		message,
		level: entry.level === level ? undefined : entry.level,
	});
	core.log[level](payload);
}

function getEvlogTag(entry: LogEntry): string {
	return getString(entry.data._source) ?? getString(entry.bindings.name) ?? 'app';
}

function completedMessage(kind: string): string {
	return `${kind} completed`;
}

function assertEvlogInstalled(): void {
	try {
		requireFromHere.resolve('evlog');
	} catch (error) {
		if (isMissingModuleError(error)) {
			throw new Error('@slipher/logger createEvlogAdapter() requires "evlog"; install it in your application.');
		}
		throw error;
	}
}

async function importEvlogCore(): Promise<EvlogCoreModule> {
	try {
		return await importEsmModule<EvlogCoreModule>('evlog');
	} catch (error) {
		if (isMissingModuleError(error)) {
			throw new Error('@slipher/logger createEvlogAdapter() requires "evlog"; install it in your application.');
		}
		throw error;
	}
}

function isMissingModuleError(error: unknown): boolean {
	if (!(error instanceof Error) || !('code' in error)) return false;
	return error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_MODULE_NOT_FOUND';
}

function importEsmModule<TModule>(specifier: string): Promise<TModule> {
	const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<TModule>;
	return importer(specifier).catch(error => {
		if (error instanceof TypeError && error.message.includes('dynamic import callback')) {
			return import(specifier) as Promise<TModule>;
		}

		throw error;
	});
}

function toEvlogLevel(level: WritableLogLevel): EvlogLevel {
	if (level === 'trace') return 'debug';
	if (level === 'fatal') return 'error';
	return level;
}
