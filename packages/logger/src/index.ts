import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { Logger as SeyfertLogger } from 'seyfert';
import { LogLevels as SeyfertLogLevels } from 'seyfert/lib/common';

import './seyfert';

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
	adapter?: LoggerAdapter;
	now?: () => Date;
}

export interface LoggerPluginOptions extends LoggerOptions {
	context?: AutoContextConfig;
	interceptInternal?: boolean;
}

export interface LoggerPlugin {
	name: string;
	options?(current: Readonly<Record<string, unknown>>): LoggerPluginOptionsFragment;
	setup?(client: SeyfertClientLike): Awaitable<void>;
	teardown?(client: SeyfertClientLike): Awaitable<void>;
}

export interface LoggerPluginOptionsFragment {
	contextScopes?: readonly LoggerContextScope[];
	context?(source: unknown): Record<string, unknown>;
	commands?: { defaults?: CommandLoggerDefaults };
	components?: { defaults?: ComponentLoggerDefaults };
	modals?: { defaults?: ComponentLoggerDefaults };
}

export type LoggerContextScope = <T>(context: unknown, run: () => Awaitable<T>) => Awaitable<T>;

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
	slipherLogger?: unknown;
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
	interactionId?: string;
}

export type AutoContextField =
	| 'kind'
	| 'command'
	| 'customId'
	| 'guildId'
	| 'channelId'
	| 'userId'
	| 'interactionId'
	| 'shardId';

export type AutoContextConfig = Partial<Record<AutoContextField, boolean>>;

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
	child?(bindings: LogBindings): PinoLoggerLike;
	flush?(): Awaitable<void>;
}

export type PinoLogMethod = (payload: Record<string, unknown>, message?: string) => unknown;

export type EvlogLevel = 'debug' | 'info' | 'warn' | 'error';

type EvlogLogMethod = {
	(tag: string, message: string): void;
	(event: Record<string, unknown>): void;
};

interface EvlogRequestLogger {
	set(context: Record<string, unknown>): void;
	setLevel(level: EvlogLevel): void;
	emit(overrides?: Record<string, unknown>): Record<string, unknown> | null;
}

interface EvlogCoreModule {
	log: Record<EvlogLevel, EvlogLogMethod>;
	createLogger(initialContext?: Record<string, unknown>): EvlogRequestLogger;
}

const loggerScope = new AsyncLocalStorage<WideEventLogger>();
const requireFromHere = createRequire(__filename);

const levelValues: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Number.POSITIVE_INFINITY,
};

const defaultContextConfig: Record<AutoContextField, boolean> = {
	kind: true,
	command: true,
	customId: true,
	guildId: true,
	channelId: true,
	userId: true,
	interactionId: true,
	shardId: false,
};

export class RootLogger {
	private readonly level: LogLevel;
	private readonly bindings: LogBindings;
	private readonly adapter: LoggerAdapter;
	private readonly now: () => Date;

	constructor(options: LoggerOptions = {}) {
		this.level = options.level ?? 'info';
		this.bindings = stripUndefined({ name: options.name, ...(options.bindings ?? {}) });
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
			level: this.level,
			bindings: { ...this.bindings, ...bindings },
			adapter: this.adapter.child?.(bindings) ?? this.adapter,
			now: this.now,
		});
	}

	event(data: LogData = {}): WideEventLogger {
		return new WideEventLogger(this, data, { bindings: this.bindings });
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

	private write(level: WritableLogLevel, args: readonly unknown[]): Awaitable<void> {
		return this.writeLevel(level, args);
	}
}

export class WideEventLogger {
	private readonly root: RootLogger;
	private readonly startedAt: Date;
	private readonly bindings: LogBindings;
	private highestLevel?: WritableLogLevel;
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

	hasLogAtLeast(level: WritableLogLevel): boolean {
		return this.highestLevel !== undefined && levelValues[this.highestLevel] >= levelValues[level];
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
		if (!this.root.isEnabled(level)) return;
		if (!this.highestLevel || levelValues[level] > levelValues[this.highestLevel]) this.highestLevel = level;
		return this.root.writeLevel(level, args);
	}
}

export { RootLogger as Logger };

export class ConsoleLoggerAdapter implements LoggerAdapter {
	write(entry: LogEntry): void {
		const payload = stripUndefined({
			time: entry.time.toISOString(),
			level: entry.level,
			message: entry.message,
			...entry.bindings,
			...entry.data,
		});
		const writer = getConsoleWriter(entry.level);

		if (process.env.NODE_ENV === 'production') {
			writer(JSON.stringify(payload));
			return;
		}

		writer(formatConsolePayload(payload));
	}
}

export function createLogger(options: LoggerOptions = {}): RootLogger {
	return new RootLogger(options);
}

export function useLogger(): WideEventLogger {
	const current = loggerScope.getStore();
	if (!current) {
		throw new Error('Cannot access logger outside of a Seyfert logger scope.');
	}
	return current;
}

export function logger(options: LoggerPluginOptions = {}): LoggerPlugin {
	const root = createLogger(options);
	const contextConfig = resolveContextConfig(options.context);

	return {
		name: '@slipher/logger',
		options: () => ({
			context: source => ({ logger: root.event(buildSeyfertEventContext(source, 'command', contextConfig)) }),
			contextScopes: [
				(context, run) => loggerScope.run(getContextLogger(root, context, 'command', contextConfig), run),
			],
			commands: { defaults: createCommandDefaults(root, contextConfig) },
			components: { defaults: createComponentDefaults(root, 'component', contextConfig) },
			modals: { defaults: createComponentDefaults(root, 'modal', contextConfig) },
		}),
		setup: client => {
			installSeyfertLogger(client, root);
			if (options.interceptInternal ?? true) installSeyfertInternalLogger(root);
		},
		teardown: () => root.flush(),
	};
}

export function installSeyfertLogger<TClient extends SeyfertClientLike>(
	client: TClient,
	rootLogger: RootLogger,
): RootLogger {
	client.slipherLogger = rootLogger;
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
		child: target.child ? bindings => createPinoLoggerAdapter(target.child?.(bindings) ?? target) : undefined,
		flush: target.flush ? () => target.flush?.() : undefined,
	};
}

export function createEvlogAdapter(): LoggerAdapter {
	assertEvlogInstalled();
	const core = importEvlogCore();

	return {
		async write(entry) {
			if (!isEvlogLifecycleEntry(entry)) {
				writeEvlogImmediateEntry(entry, await core);
				return;
			}

			writeEvlogWideEvent(entry, await core);
		},
	};
}

export function extractSeyfertLogContext(context: unknown, config: AutoContextConfig = {}): SeyfertLogContext {
	const resolvedConfig = resolveContextConfig(config);
	const source = asRecord(context);
	const interaction = asRecord(source.interaction ?? source);
	const member = asRecord(source.member ?? interaction.member);
	const author = asRecord(source.author ?? source.user ?? interaction.user ?? member.user);
	const resolver = asRecord(source.resolver);

	return stripUndefined({
		command: resolvedConfig.command
			? getString(
					source.fullCommandName ??
						resolver.fullCommandName ??
						source.commandName ??
						getStringField(source.command, 'name'),
				)
			: undefined,
		customId: resolvedConfig.customId
			? getString(source.customId ?? source.custom_id ?? interaction.customId ?? interaction.custom_id)
			: undefined,
		guildId: resolvedConfig.guildId
			? getString(source.guildId ?? source.guild_id ?? interaction.guildId ?? interaction.guild_id)
			: undefined,
		channelId: resolvedConfig.channelId
			? getString(source.channelId ?? source.channel_id ?? interaction.channelId ?? interaction.channel_id)
			: undefined,
		shardId: resolvedConfig.shardId ? getNumber(source.shardId ?? interaction.shardId) : undefined,
		userId: resolvedConfig.userId ? getString(author.id) : undefined,
		interactionId: resolvedConfig.interactionId
			? getString(source.interactionId ?? interaction.id ?? source.id)
			: undefined,
	});
}

function createCommandDefaults(
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
): CommandLoggerDefaults {
	return {
		onBeforeMiddlewares: context => {
			getContextLogger(root, context, 'command', contextConfig).debug('command received');
		},
		onBeforeOptions: context => {
			getContextLogger(root, context, 'command', contextConfig).debug('command options parsing');
		},
		onRunError: (context, error) => {
			getContextLogger(root, context, 'command', contextConfig).error(error, 'command failed');
		},
		onMiddlewaresError: (context, error) => {
			const contextLogger = getContextLogger(root, context, 'command', contextConfig);
			contextLogger.error(error, 'command middleware failed');
			return contextLogger.emit({ outcome: 'error', message: 'command middleware failed', error });
		},
		onOptionsError: (context, metadata) => {
			const contextLogger = getContextLogger(root, context, 'command', contextConfig);
			contextLogger.error({ metadata }, 'command options failed');
			return contextLogger.emit({
				outcome: 'error',
				message: 'command options failed',
				data: { metadata },
			});
		},
		onPermissionsFail: (context, permissions) => {
			const contextLogger = getContextLogger(root, context, 'command', contextConfig);
			contextLogger.warn('command permission denied', { permissions });
			return contextLogger.emit({
				outcome: 'denied',
				level: 'warn',
				message: 'command permission denied',
				data: { permissions },
			});
		},
		onBotPermissionsFail: (context, permissions) => {
			const contextLogger = getContextLogger(root, context, 'command', contextConfig);
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
		onAfterRun: (context, error) => closeRun(root, context, 'command', error, contextConfig),
	};
}

function createComponentDefaults(
	root: RootLogger,
	kind: 'component' | 'modal',
	contextConfig: Record<AutoContextField, boolean>,
): ComponentLoggerDefaults {
	return {
		onBeforeMiddlewares: context => {
			getContextLogger(root, context, kind, contextConfig).debug(`${kind} received`);
		},
		onRunError: (context, error) => {
			getContextLogger(root, context, kind, contextConfig).error(error, `${kind} failed`);
		},
		onMiddlewaresError: (context, error) => {
			const contextLogger = getContextLogger(root, context, kind, contextConfig);
			contextLogger.error(error, `${kind} middleware failed`);
			return contextLogger.emit({ outcome: 'error', message: `${kind} middleware failed`, error });
		},
		onInternalError: (_client, error) => root.error(withError({ kind }, error), `${kind} internal error`),
		onAfterRun: (context, error) => closeRun(root, context, kind, error, contextConfig),
	};
}

function closeRun(
	root: RootLogger,
	context: unknown,
	kind: 'command' | 'component' | 'modal',
	error: unknown | undefined,
	contextConfig: Record<AutoContextField, boolean>,
): Awaitable<void> {
	const contextLogger = getContextLogger(root, context, kind, contextConfig);
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
	contextConfig: Record<AutoContextField, boolean>,
): WideEventLogger {
	const data = buildSeyfertEventContext(context, kind, contextConfig);
	const scopedLogger = loggerScope.getStore();
	if (scopedLogger) {
		scopedLogger.add(data);
		return scopedLogger;
	}

	const source = asRecord(context) as { logger?: unknown };
	if (source.logger instanceof WideEventLogger) {
		source.logger.add(data);
		return source.logger;
	}

	return root.event(data);
}

function buildSeyfertEventContext(
	context: unknown,
	kind: 'command' | 'component' | 'modal',
	contextConfig: Record<AutoContextField, boolean>,
): LogData {
	return {
		...(contextConfig.kind ? { kind } : {}),
		...extractSeyfertLogContext(context, contextConfig),
	};
}

function resolveContextConfig(config: AutoContextConfig = {}): Record<AutoContextField, boolean> {
	return { ...defaultContextConfig, ...config };
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

function withError(data: LogData, error: unknown): LogData {
	if (error === undefined) return data;
	return { ...data, error };
}

function entryToAdapterPayload(entry: LogEntry): Record<string, unknown> {
	return stripUndefined({ ...entry.data });
}

function isEvlogLifecycleEntry(entry: LogEntry): boolean {
	return typeof entry.data.durationMs === 'number' && typeof entry.data.outcome === 'string';
}

function writeEvlogImmediateEntry(entry: LogEntry, core: EvlogCoreModule): void {
	const level = toEvlogLevel(entry.level);
	const tag = getEvlogTag(entry);
	const message = entry.message ?? defaultWideEventMessage(tag, 'success');
	const data = entryToEvlogPayload(entry, { message, tag });

	if (Object.keys(data).length > 2 || entry.level !== level) {
		if (entry.level !== level) data.level = entry.level;
		core.log[level](data);
		return;
	}

	core.log[level](tag, message);
}

function writeEvlogWideEvent(entry: LogEntry, core: EvlogCoreModule): void {
	const message = entry.message ?? defaultWideEventMessage(getString(entry.data.kind) ?? 'event', 'success');
	const logger = core.createLogger(stripUndefined({ ...entry.bindings, tag: getEvlogTag(entry) }));
	logger.set(stripUndefined({ ...entry.data, message }));
	logger.setLevel(toEvlogLevel(entry.level));
	if (entry.level === 'trace' || entry.level === 'fatal') logger.set({ level: entry.level });
	logger.emit();
}

function entryToEvlogPayload(entry: LogEntry, base: { message: string; tag: string }): Record<string, unknown> {
	return stripUndefined({
		...entry.bindings,
		...entry.data,
		...base,
	});
}

function getEvlogTag(entry: LogEntry): string {
	return getString(entry.data.source) ?? getString(entry.bindings.name) ?? 'app';
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

function setLoggerOn(target: unknown, rootLogger: RootLogger): void {
	if (!target || typeof target !== 'object') return;
	(target as { logger?: RootLogger }).logger = rootLogger;
}

function setInternalLoggerOn(target: unknown, rootLogger: RootLogger): void {
	if (!target || typeof target !== 'object') return;
	(target as { __logger__?: RootLogger }).__logger__ = rootLogger;
}

type SeyfertCustomizeLoggerCallback = (
	self: SeyfertLogger,
	level: SeyfertLogLevels,
	args: unknown[],
) => unknown[] | undefined;

function installSeyfertInternalLogger(root: RootLogger): void {
	const previous = (SeyfertLogger as unknown as { __callback?: SeyfertCustomizeLoggerCallback }).__callback;

	SeyfertLogger.customize((self, level, args) => {
		const mappedLevel = mapSeyfertLogLevel(level);
		void root.writeEntry({
			level: mappedLevel,
			time: root.timestamp(),
			bindings: {},
			data: buildSeyfertInternalLogData(self, args),
			message: formatSeyfertLogMessage(args),
		});

		previous?.(self, level, args);
		return undefined;
	});
}

function buildSeyfertInternalLogData(self: SeyfertLogger, args: readonly unknown[]): LogData {
	const data: LogData = {
		source: `seyfert:${normalizeSeyfertLoggerName(self.name)}`,
	};
	const error = args.find((value): value is Error => value instanceof Error);
	if (error) data.err = error;
	return data;
}

function normalizeSeyfertLoggerName(name: string): string {
	return name.replace(/^\[|\]$/g, '') || 'internal';
}

function mapSeyfertLogLevel(level: SeyfertLogLevels): WritableLogLevel {
	switch (level) {
		case SeyfertLogLevels.Debug:
			return 'debug';
		case SeyfertLogLevels.Warn:
			return 'warn';
		case SeyfertLogLevels.Error:
			return 'error';
		case SeyfertLogLevels.Fatal:
			return 'fatal';
		default:
			return 'info';
	}
}

function formatSeyfertLogMessage(args: readonly unknown[]): string | undefined {
	const parts = args.flatMap(value => {
		if (typeof value === 'string') return [value];
		return [];
	});
	return parts.length ? parts.join(' ') : undefined;
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

function formatConsolePayload(payload: Record<string, unknown>): string {
	const { level, message, name, source, time, ...rest } = payload;
	const tag = getString(source) ?? getString(name);
	const prefix = [time, level, tag ? `[${tag}]` : undefined].filter(Boolean).join(' ');
	const suffix = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
	return `${prefix}${message ? ` ${message}` : ''}${suffix}`;
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
