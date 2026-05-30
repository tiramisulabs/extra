export type Awaitable<T> = T | Promise<T>;
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type WritableLogLevel = Exclude<LogLevel, 'silent'>;
export type LogData = Record<string, unknown>;
export type LogBindings = Record<string, unknown>;
export type LogOutcome = 'success' | 'error' | 'denied' | 'skipped';

export interface LogRecord {
	level: WritableLogLevel;
	levelValue: number;
	time: Date;
	data: LogData;
	message?: string;
}

export interface LogEntry {
	level: WritableLogLevel;
	levelValue: number;
	time: Date;
	bindings: LogBindings;
	data: LogData;
	logs: LogRecord[];
	message?: string;
	name?: string;
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
	adapter?: LoggerAdapter;
	now?: () => Date;
}

export interface LoggerPluginOptions extends LoggerOptions {
	pluginName?: string;
}

export interface LoggerPlugin {
	name: string;
	options?(current: Readonly<Record<string, unknown>>): LoggerPluginOptionsFragment;
	setup?(client: SeyfertClientLike): Awaitable<void>;
}

export interface LoggerPluginOptionsFragment {
	context?(source: unknown): Record<string, unknown>;
	commands?: { defaults?: CommandLoggerDefaults };
	components?: { defaults?: ComponentLoggerDefaults };
	modals?: { defaults?: ComponentLoggerDefaults };
}

export interface CommandLoggerDefaults {
	onBeforeMiddlewares(context: unknown): Awaitable<void>;
	onBeforeOptions(context: unknown): Awaitable<void>;
	onRunError(context: unknown, error: unknown): Awaitable<void>;
	onMiddlewaresError(context: unknown, error: unknown): Awaitable<void>;
	onOptionsError(context: unknown, metadata: unknown): Awaitable<void>;
	onPermissionsFail(context: unknown, permissions: unknown): Awaitable<void>;
	onBotPermissionsFail(context: unknown, permissions: unknown): Awaitable<void>;
	onInternalError(client: unknown, command: unknown, error?: unknown): Awaitable<void>;
	onAfterRun(context: unknown, error: unknown | undefined): Awaitable<void>;
}

export interface ComponentLoggerDefaults {
	onBeforeMiddlewares(context: unknown): Awaitable<void>;
	onRunError(context: unknown, error: unknown): Awaitable<void>;
	onMiddlewaresError(context: unknown, error: unknown): Awaitable<void>;
	onInternalError(client: unknown, error?: unknown): Awaitable<void>;
	onAfterRun(context: unknown, error: unknown | undefined): Awaitable<void>;
}

export interface SeyfertClientLike {
	logger?: unknown;
	commands?: unknown;
	components?: unknown;
	events?: unknown;
	langs?: unknown;
	cache?: unknown;
}

export interface SeyfertLogContext extends LogData {
	command?: string;
	customId?: string;
	guildId?: string;
	channelId?: string;
	shardId?: number;
	userId?: string;
	username?: string;
	interactionId?: string;
	locale?: string;
}

export interface WideEventEmitOptions {
	outcome?: LogOutcome;
	level?: WritableLogLevel;
	message?: string;
	data?: LogData;
	error?: unknown;
}

export interface PinoLoggerLike {
	trace?: PinoLogMethod;
	debug?: PinoLogMethod;
	info?: PinoLogMethod;
	warn?: PinoLogMethod;
	error?: PinoLogMethod;
	fatal?: PinoLogMethod;
	flush?(): Awaitable<void>;
}

export type PinoLogMethod = (payload: Record<string, unknown>, message?: string) => unknown;

export interface EvlogLike {
	write?(entry: LogEntry): Awaitable<void>;
	log?(entry: LogEntry): Awaitable<void>;
	emit?(name: string, entry: LogEntry): Awaitable<void>;
	flush?(): Awaitable<void>;
}

export interface EvlogAdapterOptions {
	eventName?: string;
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
	private readonly name?: string;
	private readonly level: LogLevel;
	private readonly bindings: LogBindings;
	private readonly adapter: LoggerAdapter;
	private readonly now: () => Date;

	constructor(options: LoggerOptions = {}) {
		this.name = options.name;
		this.level = options.level ?? 'info';
		this.bindings = options.bindings ?? {};
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

	child(bindings: LogBindings): RootLogger {
		return new RootLogger({
			name: this.name,
			level: this.level,
			bindings: { ...this.bindings, ...bindings },
			adapter: this.adapter.child?.(bindings) ?? this.adapter,
			now: this.now,
		});
	}

	event(data: LogData = {}): WideEventLogger {
		return new WideEventLogger(this, data);
	}

	flush(): Awaitable<void> {
		return this.adapter.flush?.();
	}

	isEnabled(level: WritableLogLevel): boolean {
		return levelValues[level] >= levelValues[this.level];
	}

	timestamp(): Date {
		return this.now();
	}

	async writeEntry(entry: LogEntry): Promise<void> {
		if (!this.isEnabled(entry.level)) return;

		try {
			await this.adapter.write(entry);
		} catch (error) {
			console.error('[logger] adapter.write failed:', error);
		}
	}

	private write(level: WritableLogLevel, args: readonly unknown[]): Awaitable<void> {
		if (!this.isEnabled(level)) return;

		const normalized = normalizeLogArguments(args);
		return this.writeEntry({
			name: this.name,
			level,
			levelValue: levelValues[level],
			time: this.timestamp(),
			bindings: this.bindings,
			data: normalized.data,
			logs: [],
			message: normalized.message,
		});
	}
}

export class WideEventLogger {
	private readonly root: RootLogger;
	private readonly startedAt: Date;
	private readonly records: LogRecord[] = [];
	private data: LogData;
	private emitted = false;
	private emitPromise?: Promise<void>;

	constructor(root: RootLogger, data: LogData = {}) {
		this.root = root;
		this.startedAt = root.timestamp();
		this.data = data;
	}

	add(data: LogData): this {
		this.data = { ...this.data, ...data };
		return this;
	}

	trace(...args: readonly unknown[]): void {
		this.record('trace', args);
	}

	debug(...args: readonly unknown[]): void {
		this.record('debug', args);
	}

	info(...args: readonly unknown[]): void {
		this.record('info', args);
	}

	warn(...args: readonly unknown[]): void {
		this.record('warn', args);
	}

	error(...args: readonly unknown[]): void {
		this.record('error', args);
	}

	fatal(...args: readonly unknown[]): void {
		this.record('fatal', args);
	}

	flush(): Awaitable<void> {
		return this.root.flush();
	}

	hasLogAtLeast(level: WritableLogLevel): boolean {
		return this.records.some(record => record.levelValue >= levelValues[level]);
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

		const level = options.level ?? selectWideEventLevel(outcome, this.records);
		const kind = getString(data.kind) ?? 'event';
		await this.root.writeEntry({
			level,
			levelValue: levelValues[level],
			time,
			bindings: {},
			data,
			logs: [...this.records],
			message: options.message ?? defaultWideEventMessage(kind, outcome),
		});
	}

	private record(level: WritableLogLevel, args: readonly unknown[]): void {
		if (!this.root.isEnabled(level)) return;

		const normalized = normalizeLogArguments(args);
		this.add(normalized.data);
		this.records.push({
			level,
			levelValue: levelValues[level],
			time: this.root.timestamp(),
			data: normalized.data,
			message: normalized.message,
		});
	}
}

export { RootLogger as Logger };

export class ConsoleLoggerAdapter implements LoggerAdapter {
	write(entry: LogEntry): void {
		const payload = {
			time: entry.time.toISOString(),
			level: entry.level,
			levelValue: entry.levelValue,
			name: entry.name,
			bindings: entry.bindings,
			data: entry.data,
			logs: entry.logs,
		};
		const writer = getConsoleWriter(entry.level);

		if (entry.message) writer(entry.message, stripUndefined(payload));
		else writer(stripUndefined(payload));
	}
}

export function createLogger(options: LoggerOptions = {}): RootLogger {
	return new RootLogger(options);
}

export function logger(options: LoggerPluginOptions = {}): LoggerPlugin {
	const root = createLogger(options);

	return {
		name: options.pluginName ?? '@slipher/logger',
		options: () => ({
			context: source => ({ logger: root.event(extractSeyfertLogContext(source)) }),
			commands: { defaults: createCommandDefaults(root) },
			components: { defaults: createComponentDefaults(root, 'component') },
			modals: { defaults: createComponentDefaults(root, 'modal') },
		}),
		setup: client => {
			installSeyfertLogger(client, root);
		},
	};
}

export function installSeyfertLogger<TClient extends SeyfertClientLike>(
	client: TClient,
	rootLogger: RootLogger,
): RootLogger {
	client.logger = rootLogger;
	setLoggerOn(client.commands, rootLogger);
	setLoggerOn(client.components, rootLogger);
	setLoggerOn(client.events, rootLogger);
	setLoggerOn(client.langs, rootLogger);
	setLoggerOn(client.cache, rootLogger);
	setInternalLoggerOn(client.cache, rootLogger);
	return rootLogger;
}

export function createPinoLoggerAdapter(target: PinoLoggerLike): LoggerAdapter {
	return {
		write(entry) {
			const method = target[entry.level] ?? target.info;
			if (!method) return;
			method.call(target, entryToAdapterPayload(entry), entry.message);
		},
		flush: target.flush ? () => target.flush?.() : undefined,
	};
}

export function createEvlogLoggerAdapter(target: EvlogLike, options: EvlogAdapterOptions = {}): LoggerAdapter {
	const eventName = options.eventName ?? 'slipher.log';
	return {
		write(entry) {
			if (target.write) return target.write(entry);
			if (target.log) return target.log(entry);
			if (target.emit) return target.emit(eventName, entry);
		},
		flush: target.flush ? () => target.flush?.() : undefined,
	};
}

export function extractSeyfertLogContext(context: unknown): SeyfertLogContext {
	const source = asRecord(context);
	const interaction = asRecord(source.interaction ?? source);
	const member = asRecord(source.member ?? interaction.member);
	const author = asRecord(source.author ?? source.user ?? interaction.user ?? member.user);
	const resolver = asRecord(source.resolver);

	return stripUndefined({
		command: getString(
			source.fullCommandName ??
				resolver.fullCommandName ??
				source.commandName ??
				getStringField(source.command, 'name'),
		),
		customId: getString(source.customId ?? source.custom_id ?? interaction.customId ?? interaction.custom_id),
		guildId: getString(source.guildId ?? source.guild_id ?? interaction.guildId ?? interaction.guild_id),
		channelId: getString(source.channelId ?? source.channel_id ?? interaction.channelId ?? interaction.channel_id),
		shardId: getNumber(source.shardId ?? interaction.shardId),
		userId: getString(author.id),
		username: getString(author.username),
		interactionId: getString(source.interactionId ?? interaction.id ?? source.id),
		locale: getString(source.locale ?? interaction.locale ?? interaction.guildLocale ?? interaction.guild_locale),
	});
}

function createCommandDefaults(root: RootLogger): CommandLoggerDefaults {
	return {
		onBeforeMiddlewares: context => {
			getContextLogger(root, context, 'command').debug('command received');
		},
		onBeforeOptions: context => {
			getContextLogger(root, context, 'command').debug('command options parsing');
		},
		onRunError: (context, error) => {
			getContextLogger(root, context, 'command').error(error, 'command failed');
		},
		onMiddlewaresError: (context, error) => {
			const contextLogger = getContextLogger(root, context, 'command');
			contextLogger.error(error, 'command middleware failed');
			return contextLogger.emit({ outcome: 'error', message: 'command middleware failed', error });
		},
		onOptionsError: (context, metadata) => {
			const contextLogger = getContextLogger(root, context, 'command');
			contextLogger.error({ metadata }, 'command options failed');
			return contextLogger.emit({ outcome: 'error', message: 'command options failed', data: { metadata } });
		},
		onPermissionsFail: (context, permissions) => {
			const contextLogger = getContextLogger(root, context, 'command');
			contextLogger.warn('command permission denied', { permissions });
			return contextLogger.emit({
				outcome: 'denied',
				level: 'warn',
				message: 'command permission denied',
				data: { permissions },
			});
		},
		onBotPermissionsFail: (context, permissions) => {
			const contextLogger = getContextLogger(root, context, 'command');
			contextLogger.warn('bot permission denied', { permissions });
			return contextLogger.emit({
				outcome: 'denied',
				level: 'warn',
				message: 'bot permission denied',
				data: { permissions },
			});
		},
		onInternalError: (_client, command, error) =>
			root.error(withError({ command: getStringField(command, 'name') }, error), 'command internal error'),
		onAfterRun: (context, error) => closeRun(root, context, 'command', error),
	};
}

function createComponentDefaults(root: RootLogger, kind: 'component' | 'modal'): ComponentLoggerDefaults {
	return {
		onBeforeMiddlewares: context => {
			getContextLogger(root, context, kind).debug(`${kind} received`);
		},
		onRunError: (context, error) => {
			getContextLogger(root, context, kind).error(error, `${kind} failed`);
		},
		onMiddlewaresError: (context, error) => {
			const contextLogger = getContextLogger(root, context, kind);
			contextLogger.error(error, `${kind} middleware failed`);
			return contextLogger.emit({ outcome: 'error', message: `${kind} middleware failed`, error });
		},
		onInternalError: (_client, error) => root.error(withError({ kind }, error), `${kind} internal error`),
		onAfterRun: (context, error) => closeRun(root, context, kind, error),
	};
}

function closeRun(
	root: RootLogger,
	context: unknown,
	kind: 'command' | 'component' | 'modal',
	error: unknown | undefined,
): Awaitable<void> {
	const contextLogger = getContextLogger(root, context, kind);
	if (error !== undefined) {
		if (!contextLogger.hasLogAtLeast('error')) contextLogger.error(error, `${kind} failed`);
		return contextLogger.emit({ outcome: 'error', message: `${kind} failed`, error });
	}
	return contextLogger.emit({ outcome: 'success', message: `${kind} completed` });
}

function getContextLogger(
	root: RootLogger,
	context: unknown,
	kind: 'command' | 'component' | 'modal',
): WideEventLogger {
	const source = asRecord(context) as { logger?: unknown };
	const data = { kind, ...extractSeyfertLogContext(context) };
	if (source.logger instanceof WideEventLogger) {
		source.logger.add(data);
		return source.logger;
	}

	const contextLogger = root.event(data);
	if (context && typeof context === 'object') source.logger = contextLogger;
	return contextLogger;
}

function selectWideEventLevel(outcome: LogOutcome, records: readonly LogRecord[]): WritableLogLevel {
	let level: WritableLogLevel = outcome === 'error' ? 'error' : outcome === 'denied' ? 'warn' : 'info';
	for (const record of records) {
		if (record.levelValue > levelValues[level]) level = record.level;
	}
	return level;
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

function withError(data: LogData, error: unknown): LogData {
	if (error === undefined) return data;
	return { ...data, error };
}

function entryToAdapterPayload(entry: LogEntry): Record<string, unknown> {
	const { message: _message, ...payload } = entry;
	return stripUndefined(payload);
}

function setLoggerOn(target: unknown, rootLogger: RootLogger): void {
	if (!target || typeof target !== 'object') return;
	(target as { logger?: RootLogger }).logger = rootLogger;
}

function setInternalLoggerOn(target: unknown, rootLogger: RootLogger): void {
	if (!target || typeof target !== 'object') return;
	(target as { __logger__?: RootLogger }).__logger__ = rootLogger;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isLogData(value: unknown): value is LogData {
	return (
		!!value &&
		typeof value === 'object' &&
		!(value instanceof Date) &&
		!(value instanceof Error) &&
		!Array.isArray(value)
	);
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
