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

			if (isEvlogLifecycleEntry(entry)) {
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
