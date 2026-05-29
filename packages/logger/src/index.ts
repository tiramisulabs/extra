export type Awaitable<T> = T | Promise<T>;
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type WritableLogLevel = Exclude<LogLevel, 'silent'>;
export type LogBindings = Record<string, unknown>;
export type LogData = Record<string, unknown>;

export interface LogEntry {
	level: WritableLogLevel;
	levelValue: number;
	time: Date;
	bindings: LogBindings;
	data: LogData;
	name?: string;
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
	redact?: readonly string[];
	adapter?: LoggerAdapter;
	now?: () => Date;
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

export class Logger {
	private readonly name?: string;
	private readonly level: LogLevel;
	private readonly bindings: LogBindings;
	private readonly redactKeys: readonly string[];
	private readonly adapter: LoggerAdapter;
	private readonly now: () => Date;

	constructor(options: LoggerOptions = {}) {
		this.name = options.name;
		this.level = options.level ?? 'info';
		this.bindings = options.bindings ?? {};
		this.redactKeys = options.redact ?? [];
		this.adapter = options.adapter ?? new ConsoleLoggerAdapter();
		this.now = options.now ?? (() => new Date());
	}

	trace(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('trace', data, message);
	}

	debug(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('debug', data, message);
	}

	info(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('info', data, message);
	}

	warn(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('warn', data, message);
	}

	error(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('error', data, message);
	}

	fatal(data?: LogData | string | Error, message?: string): Awaitable<void> {
		return this.write('fatal', data, message);
	}

	child(bindings: LogBindings): Logger {
		const redactedBindings = redactLogValue(bindings, this.redactKeys);
		return new Logger({
			name: this.name,
			level: this.level,
			bindings: { ...this.bindings, ...redactedBindings },
			redact: this.redactKeys,
			adapter: this.adapter.child?.(redactedBindings) ?? this.adapter,
			now: this.now,
		});
	}

	flush(): Awaitable<void> {
		return this.adapter.flush?.();
	}

	private write(level: WritableLogLevel, data?: LogData | string | Error, message?: string): Awaitable<void> {
		if (levelValues[level] < levelValues[this.level]) return;

		const normalized = normalizeLogArguments(data, message);
		const entry: LogEntry = {
			name: this.name,
			level,
			levelValue: levelValues[level],
			time: this.now(),
			bindings: redactLogValue(this.bindings, this.redactKeys),
			data: redactLogValue(normalized.data, this.redactKeys),
			message: normalized.message,
		};

		return this.adapter.write(entry);
	}
}

export class ConsoleLoggerAdapter implements LoggerAdapter {
	write(entry: LogEntry): void {
		const payload = {
			time: entry.time.toISOString(),
			level: entry.level,
			name: entry.name,
			...entry.bindings,
			...entry.data,
		};
		const writer = getConsoleWriter(entry.level);

		if (entry.message) writer(entry.message, payload);
		else writer(payload);
	}
}

export function createLogger(options: LoggerOptions = {}): Logger {
	return new Logger(options);
}

export function redactLogValue<T>(value: T, keys: readonly string[], replacement = '[Redacted]'): T {
	if (!keys.length) return value;
	const normalizedKeys = new Set(keys.map(key => key.toLowerCase()));
	return redactValue(value, normalizedKeys, replacement) as T;
}

function normalizeLogArguments(data?: LogData | string | Error, message?: string): { data: LogData; message?: string } {
	if (typeof data === 'string') return { data: {}, message: data };
	if (data instanceof Error) return { data: { error: serializeError(data) }, message };
	return { data: data ?? {}, message };
}

function redactValue(
	value: unknown,
	keys: ReadonlySet<string>,
	replacement: string,
	seen = new WeakSet<object>(),
): unknown {
	if (Array.isArray(value)) {
		if (seen.has(value)) return '[Circular]';
		seen.add(value);
		const result = value.map(item => redactValue(item, keys, replacement, seen));
		seen.delete(value);
		return result;
	}
	if (value instanceof Date) return value;
	if (value instanceof Error) return redactValue(serializeError(value), keys, replacement, seen);
	if (!isPlainObject(value)) return value;
	if (seen.has(value)) return '[Circular]';
	seen.add(value);

	const result: Record<string, unknown> = {};
	for (const [key, nestedValue] of Object.entries(value)) {
		result[key] = keys.has(key.toLowerCase()) ? replacement : redactValue(nestedValue, keys, replacement, seen);
	}
	seen.delete(value);
	return result;
}

function serializeError(error: Error): LogData {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function getConsoleWriter(level: WritableLogLevel): (...args: unknown[]) => void {
	switch (level) {
		case 'trace':
		case 'debug':
			return console.debug;
		case 'warn':
			return console.warn;
		case 'error':
		case 'fatal':
			return console.error;
		default:
			return console.info;
	}
}
