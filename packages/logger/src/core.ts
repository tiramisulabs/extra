import { ConsoleLoggerAdapter } from './console';
import { getString, isLogData, stripUndefined } from './utils';

export type Awaitable<T> = T | Promise<T>;
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type WritableLogLevel = Exclude<LogLevel, 'silent'>;
export type LogData = Record<string, unknown>;
export type LogBindings = Record<string, unknown>;
export type LogOutcome = 'success' | 'error' | 'denied' | 'skipped';

export interface LogEntry {
	level: WritableLogLevel;
	time: Date;
	bindings: LogBindings;
	data: LogData;
	message?: string;
}

export interface LoggerAdapter {
	write(entry: LogEntry): Awaitable<void>;
	child?(bindings: LogBindings): LoggerAdapter;
	flush?(): Awaitable<void>;
}

export interface LoggerOptions {
	name?: string;
	level?: LogLevel;
	bindings?: LogBindings;
	/** The single thing that prints to the terminal. Defaults to a pretty console. */
	renderer?: LoggerAdapter;
	/** Structured sinks (evlog/pino/file). They ship the entry; they don't own the console. */
	transports?: readonly LoggerAdapter[];
	/** @internal Pre-resolved adapter list, used by `child()`. */
	adapters?: readonly LoggerAdapter[];
	now?: () => Date;
}

function resolveAdapters(options: LoggerOptions): readonly LoggerAdapter[] {
	if (options.adapters) return options.adapters;
	return [options.renderer ?? new ConsoleLoggerAdapter(), ...(options.transports ?? [])];
}

export interface WideEventEmitOptions {
	outcome?: LogOutcome;
	level?: WritableLogLevel;
	message?: string;
	data?: LogData;
	error?: unknown;
}

const levelValues: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Number.POSITIVE_INFINITY,
};

export class RootLogger {
	private readonly level: LogLevel;
	private readonly bindings: LogBindings;
	private readonly adapters: readonly LoggerAdapter[];
	private readonly now: () => Date;

	constructor(options: LoggerOptions = {}) {
		this.level = options.level ?? 'info';
		this.bindings = stripUndefined({ name: options.name, ...(options.bindings ?? {}) });
		this.adapters = resolveAdapters(options);
		this.now = options.now ?? (() => new Date());
	}

	trace(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('trace', args);
	}

	debug(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('debug', args);
	}

	info(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('info', args);
	}

	warn(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('warn', args);
	}

	error(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('error', args);
	}

	fatal(...args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel('fatal', args);
	}

	child(bindings: LogBindings): RootLogger {
		return new RootLogger({
			level: this.level,
			bindings: { ...this.bindings, ...bindings },
			adapters: this.adapters.map(adapter => adapter.child?.(bindings) ?? adapter),
			now: this.now,
		});
	}

	event(data: LogData = {}): WideEventLogger {
		return new WideEventLogger(this, data, { bindings: this.bindings });
	}

	flush(): Awaitable<void> {
		return Promise.all(this.adapters.map(adapter => adapter.flush?.())).then(() => undefined);
	}

	isEnabled(level: WritableLogLevel): boolean {
		return levelValues[level] >= levelValues[this.level];
	}

	timestamp(): Date {
		return this.now();
	}

	async writeEntry(entry: LogEntry): Promise<void> {
		if (!this.isEnabled(entry.level)) return;

		await Promise.all(
			this.adapters.map(async adapter => {
				try {
					await adapter.write(entry);
				} catch (error) {
					console.error('[logger] adapter.write failed:', error);
				}
			}),
		);
	}

	writeLevel(level: WritableLogLevel, args: readonly unknown[]): Awaitable<void> {
		if (!this.isEnabled(level)) return;

		const normalized = normalizeLogArguments(args);
		return this.writeEntry({
			level,
			time: this.timestamp(),
			bindings: this.bindings,
			data: normalized.data,
			message: normalized.message,
		});
	}
}

export class WideEventLogger {
	private readonly root: RootLogger;
	private readonly startedAt: Date;
	private readonly bindings: LogBindings;
	private data: LogData;
	private emitted = false;
	private emitPromise?: Promise<void>;

	constructor(root: RootLogger, data: LogData = {}, metadata: Pick<LogEntry, 'bindings'> = { bindings: {} }) {
		this.root = root;
		this.startedAt = root.timestamp();
		this.bindings = metadata.bindings;
		this.data = data;
	}

	add(data: LogData): this {
		this.data = { ...this.data, ...data };
		return this;
	}

	get currentContext(): Readonly<LogData> {
		return Object.freeze({ ...this.data });
	}

	trace(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('trace', args);
	}

	debug(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('debug', args);
	}

	info(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('info', args);
	}

	warn(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('warn', args);
	}

	error(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('error', args);
	}

	fatal(...args: readonly unknown[]): Awaitable<void> {
		return this.writeImmediate('fatal', args);
	}

	flush(): Awaitable<void> {
		return this.root.flush();
	}

	emit(options: WideEventEmitOptions = {}): Promise<void> {
		this.emitPromise ??= this.emitOnce(options);
		return this.emitPromise;
	}

	private async emitOnce(options: WideEventEmitOptions): Promise<void> {
		if (this.emitted) return;
		this.emitted = true;

		const time = this.root.timestamp();
		const outcome = options.outcome ?? (options.error === undefined ? 'success' : 'error');
		const data: LogData = {
			...this.data,
			...(options.data ?? {}),
			outcome,
			durationMs: Math.max(0, time.getTime() - this.startedAt.getTime()),
		};
		if (options.error !== undefined) data.error = options.error;

		const level = options.level ?? selectWideEventLevel(outcome);
		const kind = getString(data.kind) ?? 'event';
		await this.root.writeEntry({
			level,
			time,
			bindings: this.bindings,
			data,
			message: options.message ?? defaultWideEventMessage(kind, outcome),
		});
	}

	private writeImmediate(level: WritableLogLevel, args: readonly unknown[]): Awaitable<void> {
		return this.root.writeLevel(level, args);
	}
}

export { RootLogger as Logger };

export function createLogger(options: LoggerOptions = {}): RootLogger {
	return new RootLogger(options);
}

function selectWideEventLevel(outcome: LogOutcome): WritableLogLevel {
	return outcome === 'error' ? 'error' : outcome === 'denied' ? 'warn' : 'info';
}

function defaultWideEventMessage(kind: string, outcome: LogOutcome): string {
	switch (outcome) {
		case 'error':
			return `${kind} failed`;
		case 'denied':
			return `${kind} permission denied`;
		case 'skipped':
			return `${kind} skipped`;
		default:
			return `${kind} completed`;
	}
}

function normalizeLogArguments(args: readonly unknown[]): { data: LogData; message?: string } {
	const [first, second, ...rest] = args;
	let data: LogData = {};
	let message: string | undefined;
	const remaining: unknown[] = [];

	if (typeof first === 'string') {
		message = first;
		remaining.push(second, ...rest);
	} else if (first instanceof Error) {
		data.error = first;
		if (typeof second === 'string') message = second;
		else remaining.push(second);
		remaining.push(...rest);
	} else if (isLogData(first)) {
		data = first;
		if (typeof second === 'string') message = second;
		else remaining.push(second);
		remaining.push(...rest);
	} else if (first !== undefined) {
		data.value = first;
		if (typeof second === 'string') message = second;
		else remaining.push(second);
		remaining.push(...rest);
	}

	const extraArgs: unknown[] = [];
	for (const value of remaining) {
		if (value === undefined) continue;
		if (value instanceof Error && data.error === undefined) {
			data.error = value;
			continue;
		}
		if (isLogData(value)) {
			data = { ...data, ...value };
			continue;
		}
		extraArgs.push(value);
	}
	if (extraArgs.length) data.args = extraArgs;

	return { data, message };
}
