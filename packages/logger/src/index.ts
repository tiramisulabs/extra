import { createMiddleware } from 'seyfert';

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

const circularReplacement = '[Circular]';

export interface LoggerOptions {
	name?: string;
	level?: LogLevel;
	bindings?: LogBindings;
	redact?: readonly string[];
	adapter?: LoggerAdapter;
	now?: () => Date;
}

export interface SeyfertLoggerOptions extends LoggerOptions {
	client?: SeyfertClientLike;
	defaults?: boolean;
}

export interface InstallSeyfertLoggerOptions {
	defaults?: boolean;
}

export interface SeyfertLoggerServicesOptions {
	commandMiddlewareName?: string;
	commandMiddleware?: {
		level?: WritableLogLevel;
		message?: string;
	};
}

export interface SeyfertLoggerServices {
	middlewares: Record<string, ReturnType<typeof commandLogger>>;
}

export interface SeyfertLogContext extends LogData {
	command?: string;
	guildId?: string;
	channelId?: string;
	shardId?: number;
	userId?: string;
	username?: string;
	interactionId?: string;
	locale?: string;
}

export interface SeyfertClientLike {
	logger?: unknown;
	commands?: unknown;
	components?: unknown;
	events?: unknown;
	langs?: unknown;
	cache?: unknown;
	options?: {
		globalMiddlewares?: readonly string[];
		commands?: { defaults?: Record<string, unknown> };
		components?: { defaults?: Record<string, unknown> };
		modals?: { defaults?: Record<string, unknown> };
	};
}

export interface SeyfertLoggerDefaults {
	commands: {
		onBeforeMiddlewares(context: unknown): Awaitable<void>;
		onBeforeOptions(context: unknown): Awaitable<void>;
		onRunError(context: unknown, error: unknown): Awaitable<void>;
		onMiddlewaresError(context: unknown, error: unknown): Awaitable<void>;
		onOptionsError(context: unknown, metadata: unknown): Awaitable<void>;
		onPermissionsFail(context: unknown, permissions: unknown): Awaitable<void>;
		onBotPermissionsFail(context: unknown, permissions: unknown): Awaitable<void>;
		onInternalError(client: unknown, command: unknown, error?: unknown): Awaitable<void>;
		onAfterRun(context: unknown, error: unknown | undefined): Awaitable<void>;
	};
	components: {
		onBeforeMiddlewares(context: unknown): Awaitable<void>;
		onRunError(context: unknown, error: unknown): Awaitable<void>;
		onMiddlewaresError(context: unknown, error: unknown): Awaitable<void>;
		onInternalError(client: unknown, error?: unknown): Awaitable<void>;
		onAfterRun(context: unknown, error: unknown | undefined): Awaitable<void>;
	};
	modals: {
		onBeforeMiddlewares(context: unknown): Awaitable<void>;
		onRunError(context: unknown, error: unknown): Awaitable<void>;
		onMiddlewaresError(context: unknown, error: unknown): Awaitable<void>;
		onInternalError(client: unknown, error?: unknown): Awaitable<void>;
		onAfterRun(context: unknown, error: unknown | undefined): Awaitable<void>;
	};
	events: {
		onFail(event: unknown, error: unknown): Awaitable<void>;
	};
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

	trace(...args: readonly unknown[]): Awaitable<void> {
		return this.write('trace', args);
	}

	debug(...args: readonly unknown[]): Awaitable<void> {
		return this.write('debug', args);
	}

	info(...args: readonly unknown[]): Awaitable<void> {
		return this.write('info', args);
	}

	warn(...args: readonly unknown[]): Awaitable<void> {
		return this.write('warn', args);
	}

	error(...args: readonly unknown[]): Awaitable<void> {
		return this.write('error', args);
	}

	fatal(...args: readonly unknown[]): Awaitable<void> {
		return this.write('fatal', args);
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

	private write(level: WritableLogLevel, args: readonly unknown[]): Awaitable<void> {
		if (levelValues[level] < levelValues[this.level]) return;

		const normalized = normalizeLogArguments(args);
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

export function createSeyfertLogger(options: SeyfertLoggerOptions = {}): Logger {
	const { client, defaults, ...loggerOptions } = options;
	const logger = new Logger({
		name: loggerOptions.name ?? '[Seyfert]',
		...loggerOptions,
		redact: loggerOptions.redact ?? ['authorization', 'token', 'botToken', 'webhookToken', 'interactionToken'],
	});

	if (client) installSeyfertLogger(client, logger, { defaults });
	return logger;
}

export function installSeyfertLogger<TClient extends SeyfertClientLike>(
	client: TClient,
	logger: Logger,
	options: InstallSeyfertLoggerOptions = {},
): Logger {
	client.logger = logger;
	setLoggerOn(client.commands, logger);
	setLoggerOn(client.components, logger);
	setLoggerOn(client.events, logger);
	setLoggerOn(client.langs, logger);
	setInternalLoggerOn(client.cache, logger);
	if (options.defaults) installSeyfertLoggerDefaults(client, createSeyfertLoggerDefaults(logger));
	return logger;
}

export function installSeyfertLoggerDefaults<TClient extends SeyfertClientLike>(
	client: TClient,
	defaults: SeyfertLoggerDefaults,
): TClient {
	const options = client.options ?? (client.options = {});
	options.commands = {
		...options.commands,
		defaults: { ...options.commands?.defaults, ...defaults.commands },
	};
	options.components = {
		...options.components,
		defaults: { ...options.components?.defaults, ...defaults.components },
	};
	options.modals = {
		...options.modals,
		defaults: { ...options.modals?.defaults, ...defaults.modals },
	};
	return client;
}

export function commandLogger(logger: Logger, options: { level?: WritableLogLevel; message?: string } = {}) {
	const level = options.level ?? 'info';
	const message = options.message ?? 'command executed';

	return createMiddleware<void>(async (middle: { context: unknown; next(): unknown }) => {
		await logger[level](extractSeyfertLogContext(middle.context), message);
		return middle.next();
	});
}

export function createSeyfertLoggerServices(
	logger: Logger,
	options: SeyfertLoggerServicesOptions = {},
): SeyfertLoggerServices {
	return {
		middlewares: {
			[options.commandMiddlewareName ?? 'logger']: commandLogger(logger, options.commandMiddleware),
		},
	};
}

export function createSeyfertLoggerDefaults(logger: Logger): SeyfertLoggerDefaults {
	return {
		commands: {
			onBeforeMiddlewares: context => logger.debug(extractSeyfertLogContext(context), 'command received'),
			onBeforeOptions: context => logger.debug(extractSeyfertLogContext(context), 'command options parsing'),
			onRunError: (context, error) =>
				logger.error(withError(extractSeyfertLogContext(context), error), 'command failed'),
			onMiddlewaresError: (context, error) =>
				logger.error(withError(extractSeyfertLogContext(context), error), 'command middleware failed'),
			onOptionsError: (context, metadata) =>
				logger.error({ ...extractSeyfertLogContext(context), metadata }, 'command options failed'),
			onPermissionsFail: (context, permissions) =>
				logger.warn({ ...extractSeyfertLogContext(context), permissions }, 'command permission denied'),
			onBotPermissionsFail: (context, permissions) =>
				logger.warn({ ...extractSeyfertLogContext(context), permissions }, 'bot permission denied'),
			onInternalError: (_client, command, error) =>
				logger.error(withError({ command: getStringField(command, 'name') }, error), 'command internal error'),
			onAfterRun: (context, error) =>
				logCompletion(logger, extractSeyfertLogContext(context), 'command completed', error),
		},
		components: {
			onBeforeMiddlewares: context => logger.debug(extractSeyfertLogContext(context), 'component received'),
			onRunError: (context, error) =>
				logger.error(withError(extractSeyfertLogContext(context), error), 'component failed'),
			onMiddlewaresError: (context, error) =>
				logger.error(withError(extractSeyfertLogContext(context), error), 'component middleware failed'),
			onInternalError: (_client, error) => logger.error(withError({}, error), 'component internal error'),
			onAfterRun: (context, error) =>
				logCompletion(logger, extractSeyfertLogContext(context), 'component completed', error),
		},
		modals: {
			onBeforeMiddlewares: context => logger.debug(extractSeyfertLogContext(context), 'modal received'),
			onRunError: (context, error) => logger.error(withError(extractSeyfertLogContext(context), error), 'modal failed'),
			onMiddlewaresError: (context, error) =>
				logger.error(withError(extractSeyfertLogContext(context), error), 'modal middleware failed'),
			onInternalError: (_client, error) => logger.error(withError({}, error), 'modal internal error'),
			onAfterRun: (context, error) =>
				logCompletion(logger, extractSeyfertLogContext(context), 'modal completed', error),
		},
		events: {
			onFail: (event, error) => logger.error(withError({ event }, error), 'event failed'),
		},
	};
}

export function extractSeyfertLogContext(context: unknown): SeyfertLogContext {
	const source = asRecord(context);
	const interaction = asRecord(source.interaction);
	const author = asRecord(source.author ?? interaction.user);
	const resolver = asRecord(source.resolver);

	return stripUndefined({
		command: getString(source.fullCommandName ?? resolver.fullCommandName ?? getStringField(source.command, 'name')),
		guildId: getString(source.guildId ?? interaction.guildId ?? interaction.guild_id),
		channelId: getString(source.channelId ?? interaction.channelId ?? interaction.channel_id),
		shardId: getNumber(source.shardId),
		userId: getString(author.id),
		username: getString(author.username),
		interactionId: getString(interaction.id),
		locale: getString(interaction.locale ?? interaction.guildLocale ?? interaction.guild_locale),
	});
}

export function redactLogValue<T>(value: T, keys: readonly string[], replacement = '[Redacted]'): T {
	const normalizedKeys = new Set(keys.map(key => key.toLowerCase()));
	return redactValue(value, normalizedKeys, replacement) as T;
}

function normalizeLogArguments(args: readonly unknown[]): { data: LogData; message?: string } {
	const [first, second, ...rest] = args;
	let data: LogData = {};
	let rootObject: object | undefined;
	let message: string | undefined;
	let remaining = rest;

	if (typeof first === 'string') {
		message = first;
		remaining = second === undefined ? rest : [second, ...rest];
	} else if (first instanceof Error) {
		data.error = serializeError(first);
		if (typeof second === 'string') message = second;
		else remaining = second === undefined ? rest : [second, ...rest];
	} else if (isPlainObject(first)) {
		data = { ...first };
		rootObject = first;
		if (typeof second === 'string') message = second;
		else remaining = second === undefined ? rest : [second, ...rest];
	} else if (first !== undefined) {
		data.value = serializeLogArgument(first);
		if (typeof second === 'string') message = second;
		else remaining = second === undefined ? rest : [second, ...rest];
	}

	const extraArgs: unknown[] = [];
	for (const value of remaining) {
		if (value instanceof Error && data.error === undefined) data.error = serializeError(value);
		else if (value !== undefined) extraArgs.push(serializeLogArgument(value));
	}
	if (extraArgs.length) data.args = extraArgs;

	return {
		data: redactValue(data, new Set(), circularReplacement, undefined, rootObject) as LogData,
		message,
	};
}

function redactValue(
	value: unknown,
	keys: ReadonlySet<string>,
	replacement: string,
	seen = new WeakSet<object>(),
	seenRoot?: object,
): unknown {
	if (seenRoot) seen.add(seenRoot);
	if (Array.isArray(value)) {
		if (seen.has(value)) return circularReplacement;
		seen.add(value);
		const result = value.map(item => redactValue(item, keys, replacement, seen));
		seen.delete(value);
		return result;
	}
	if (value instanceof Date) return value;
	if (value instanceof Error) return redactValue(serializeError(value), keys, replacement, seen);
	if (!isPlainObject(value)) return value;
	if (seen.has(value)) return circularReplacement;
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

function serializeLogArgument(value: unknown): unknown {
	if (value instanceof Error) return serializeError(value);
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function setLoggerOn(target: unknown, logger: Logger): void {
	if (!target || typeof target !== 'object') return;
	(target as { logger?: Logger }).logger = logger;
}

function setInternalLoggerOn(target: unknown, logger: Logger): void {
	if (!target || typeof target !== 'object') return;
	(target as { __logger__?: Logger }).__logger__ = logger;
}

function withError(data: LogData, error: unknown): LogData {
	if (error === undefined) return data;
	return error instanceof Error ? { ...data, error: serializeError(error) } : { ...data, error };
}

function logCompletion(logger: Logger, data: LogData, message: string, error: unknown | undefined): Awaitable<void> {
	if (error === undefined) return logger.info(data, message);
	return logger.error(withError(data, error), `${message} with error`);
}

function getString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getStringField(value: unknown, field: string): string | undefined {
	return getString(asRecord(value)[field]);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
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
