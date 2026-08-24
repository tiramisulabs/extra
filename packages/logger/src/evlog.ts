import { createRequire } from 'node:module';

import type { Awaitable, LogData, LogEntry, LoggerAdapter, WritableLogLevel } from './core';
import { getString, stripUndefined } from './utils';

export type EvlogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * evlog `initLogger` config. Pass it to let @slipher/logger own evlog's setup:
 * it calls `initLogger` for you, derives `env.service` from the logger `name`,
 * and sets `silent` by role (renderer prints, transport drains only). Omit it to
 * manage `initLogger` yourself — then the adapter never touches evlog's config.
 */
export interface EvlogConfig {
	env?: Record<string, unknown>;
	[key: string]: unknown;
}

type EvlogLogMethod = {
	(tag: string, message: string): void;
	(event: Record<string, unknown>): void;
};

interface EvlogCoreModule {
	log: Record<EvlogLevel, EvlogLogMethod>;
	initLogger: (config: Record<string, unknown>) => void;
}

const requireFromHere = createRequire(__filename);

/** evlog prints to the terminal AND drains. Use in `renderer`. */
export function evlogRenderer(config?: EvlogConfig): LoggerAdapter {
	return createEvlogAdapter(false, config);
}

/** evlog drains only (OTLP/fs), never prints. Use in `transports`. */
export function evlogTransport(config?: EvlogConfig): LoggerAdapter {
	return createEvlogAdapter(true, config);
}

function createEvlogAdapter(silent: boolean, config?: EvlogConfig): LoggerAdapter {
	assertEvlogInstalled();
	const core = importEvlogCore();
	const flush = getDrainFlush(config?.drain);
	let initialized = false;

	return {
		async write(entry) {
			const resolved = await core;

			// Only own evlog's setup when given config; otherwise assume the app called
			// initLogger and don't clobber its drains/silent.
			if (config && !initialized) {
				initialized = true;
				resolved.initLogger(buildInitConfig(silent, config, entry));
			}

			if (entry.shape === 'wide') {
				writeEvlogWideEvent(entry, resolved);
				return;
			}

			writeEvlogImmediateEntry(entry, resolved);
		},
		flush,
	};
}

function getDrainFlush(drain: unknown): (() => Awaitable<void>) | undefined {
	if ((typeof drain !== 'function' && (!drain || typeof drain !== 'object')) || !('flush' in drain)) return;
	const flush = drain.flush;
	return typeof flush === 'function' ? () => flush.call(drain) : undefined;
}

function buildInitConfig(silent: boolean, config: EvlogConfig, entry: LogEntry): Record<string, unknown> {
	// `env.service` defaults to the logger name so it isn't defined twice; explicit
	// `config.env.service` still wins. `silent` is role-controlled (renderer vs transport).
	return {
		...config,
		env: { service: getString(entry.bindings.name) ?? 'app', ...(config.env ?? {}) },
		silent,
	};
}

function writeEvlogImmediateEntry(entry: LogEntry, core: EvlogCoreModule): void {
	const level = toEvlogLevel(entry.level);
	const source = getEntrySource(entry);
	const message = entry.message ?? completedMessage(source);

	// `name`/`_source` carry the entry's source, never plain fields under those keys. The
	// remaining fields decide between evlog's clean tagged form and its object form.
	let extra = stripUndefined({ ...entry.bindings, ...entry.data });
	delete extra.name;
	delete extra._source;
	if (entry.level !== level) extra.level = entry.level;
	extra = translateTraceContextForEvlog(extra);

	if (Object.keys(extra).length === 0) {
		core.log[level](source, message);
		return;
	}

	// Leaving `service` unset lets evlog apply its application-level service envelope
	// instead of creating one OTLP resource per Seyfert logger source. `source` is
	// written last so a caller field of the same name cannot shadow the entry's origin.
	core.log[level]({ message, ...extra, source });
}

function writeEvlogWideEvent(entry: LogEntry, core: EvlogCoreModule): void {
	const level = toEvlogLevel(entry.level);
	const message = entry.message ?? completedMessage(getString(entry.data.kind) ?? 'event');

	// Emit via the object form (not createLogger) so evlog does not stamp its own
	// createLogger -> emit stopwatch as `duration` ("in 0ms"); our real elapsed time is
	// already in the `durationMs` field. The entry's origin travels as `source` while
	// evlog supplies the application service from its global envelope.
	let fields = stripUndefined({ ...entry.bindings, ...entry.data });
	delete fields.name;
	delete fields._source;
	fields = translateTraceContextForEvlog(fields);
	const payload: LogData = stripUndefined({
		...fields,
		source: getEntrySource(entry),
		message,
		level: entry.level === level ? undefined : entry.level,
	});
	core.log[level](payload);
}

function translateTraceContextForEvlog(fields: LogData): LogData {
	const traceId = getString(fields.trace_id);
	const spanId = getString(fields.span_id);
	if (!(traceId || spanId)) return fields;

	// evlog reads camelCase off the top-level event, so the snake_case pair never reaches
	// it; a caller that already set `traceId`/`spanId` keeps their own value.
	const translated = { ...fields };
	if (traceId) {
		delete translated.trace_id;
		translated.traceId ??= traceId;
	}
	if (spanId) {
		delete translated.span_id;
		translated.spanId ??= spanId;
	}
	return translated;
}

// `service` is the deployed application (evlog's envelope, one per bot process); `source`
// is the Seyfert surface an entry came from, many per service; `name` is a logger
// instance's own label, defaulting to the service.
function getEntrySource(entry: LogEntry): string {
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
			throw new Error('@slipher/logger evlog adapters require "evlog"; install it in your application.');
		}
		throw error;
	}
}

async function importEvlogCore(): Promise<EvlogCoreModule> {
	try {
		return await importEsmModule<EvlogCoreModule>('evlog');
	} catch (error) {
		if (isMissingModuleError(error)) {
			throw new Error('@slipher/logger evlog adapters require "evlog"; install it in your application.');
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
