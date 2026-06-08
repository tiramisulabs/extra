import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger as SeyfertLogger } from 'seyfert';
import { LogLevels as SeyfertLogLevels } from 'seyfert/lib/common';

import {
	type Awaitable,
	createLogger,
	type LogData,
	type LoggerOptions,
	type RootLogger,
	WideEventLogger,
	type WritableLogLevel,
} from './core';
import { asRecord, getNumber, getString, getStringField, stripUndefined } from './utils';

export interface LoggerPluginOptions extends LoggerOptions {
	context?: AutoContextConfig;
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

const loggerScope = new AsyncLocalStorage<WideEventLogger>();

let installedRootLogger: RootLogger | undefined;

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

export function useLogger(): WideEventLogger {
	const current = loggerScope.getStore();
	if (!current) {
		throw new Error('Cannot access logger outside of a Seyfert logger scope.');
	}
	return current;
}

export function useRootLogger(): RootLogger {
	if (!installedRootLogger) {
		throw new Error('Cannot access the root logger before the @slipher/logger plugin is set up.');
	}
	return installedRootLogger;
}

export function logger(options: LoggerPluginOptions = {}): LoggerPlugin {
	const root = createLogger(options);
	const contextConfig = resolveContextConfig(options.context);

	return {
		name: '@slipher/logger',
		options: () => ({
			context: source => ({ logger: root.event(extractSeyfertLogContext(source, contextConfig)) }),
			contextScopes: [(context, run) => loggerScope.run(getScopedLogger(root, context, contextConfig), run)],
			commands: { defaults: createCommandDefaults(root, contextConfig) },
			components: { defaults: createComponentDefaults(root, 'component', contextConfig) },
			modals: { defaults: createComponentDefaults(root, 'modal', contextConfig) },
		}),
		setup: client => {
			installSeyfertLogger(client, root);
			installSeyfertInternalLogger(root);
		},
		teardown: () => root.flush(),
	};
}

export function installSeyfertLogger<TClient extends SeyfertClientLike>(
	client: TClient,
	rootLogger: RootLogger,
): RootLogger {
	installedRootLogger = rootLogger;
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
		onRunError: (context, error) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'error',
				message: 'command failed',
				error,
			}),
		onMiddlewaresError: (context, error) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'error',
				message: 'command middleware failed',
				error,
			}),
		onOptionsError: (context, metadata) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'error',
				message: 'command options failed',
				data: { metadata },
			}),
		onPermissionsFail: (context, permissions) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'denied',
				level: 'warn',
				message: 'command permission denied',
				data: { permissions },
			}),
		onBotPermissionsFail: (context, permissions) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'denied',
				level: 'warn',
				message: 'bot permission denied',
				data: { permissions },
			}),
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
		onRunError: (context, error) =>
			getContextLogger(root, context, kind, contextConfig).emit({
				outcome: 'error',
				message: `${kind} failed`,
				error,
			}),
		onMiddlewaresError: (context, error) =>
			getContextLogger(root, context, kind, contextConfig).emit({
				outcome: 'error',
				message: `${kind} middleware failed`,
				error,
			}),
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
	// Terminal error/denied handlers (onRunError, onMiddlewaresError, ...) emit at their
	// source because afterRun does not fire on every error path. So afterRun only
	// finalizes success; emit() is idempotent if both ever run.
	if (error !== undefined) return;
	return getContextLogger(root, context, kind, contextConfig).emit({
		outcome: 'success',
		message: `${kind} completed`,
	});
}

function getContextLogger(
	root: RootLogger,
	context: unknown,
	kind: 'command' | 'component' | 'modal',
	contextConfig: Record<AutoContextField, boolean>,
): WideEventLogger {
	const data = buildSeyfertEventContext(context, kind, contextConfig);
	return getLoggerWithData(root, context, data);
}

function getScopedLogger(
	root: RootLogger,
	context: unknown,
	contextConfig: Record<AutoContextField, boolean>,
): WideEventLogger {
	return getLoggerWithData(root, context, extractSeyfertLogContext(context, contextConfig));
}

function getLoggerWithData(root: RootLogger, context: unknown, data: LogData): WideEventLogger {
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

function withError(data: LogData, error: unknown): LogData {
	if (error === undefined) return data;
	return { ...data, error };
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
		_source: `seyfert:${normalizeSeyfertLoggerName(self.name)}`,
	};

	// Strings build the message; the first Error becomes `err`; any other args
	// (objects, numbers, extra Errors) are kept as `details` instead of dropped.
	let err: Error | undefined;
	const details: unknown[] = [];
	for (const value of args) {
		if (typeof value === 'string' || value === undefined) continue;
		if (value instanceof Error && !err) {
			err = value;
			continue;
		}
		details.push(value);
	}

	if (err) data.err = err;
	if (details.length) data.details = details.length === 1 ? details[0] : details;
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
