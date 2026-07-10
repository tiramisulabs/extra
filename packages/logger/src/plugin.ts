import { AsyncLocalStorage } from 'node:async_hooks';
import {
	createPlugin,
	ModalCommand,
	type PluginCommandObserver,
	Logger as SeyfertLogger,
	LogLevels as SeyfertLogLevels,
	type SeyfertPluginOptions,
} from 'seyfert';

import {
	type Awaitable,
	createLogger,
	type LogData,
	type LoggerOptions,
	RootLogger,
	WideEventLogger,
	type WritableLogLevel,
} from './core';
import { asRecord, getNumber, getString, getStringField, stripUndefined } from './utils';

export interface LoggerPluginOptions extends LoggerOptions {
	context?: AutoContextConfig;
}

interface SeyfertClientLike {
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
const escapedObjectScopes = new WeakMap<object, WideEventLogger[]>();
const escapedPrimitiveScopes = new Map<unknown, WideEventLogger[]>();

interface InstalledLoggerProperty {
	target: Record<string, unknown>;
	key: 'logger' | '__logger__';
	hadOwnValue: boolean;
	previousValue: unknown;
}

interface LoggerInstallation {
	client: object;
	rootLogger: RootLogger;
	properties: InstalledLoggerProperty[];
	restoreInternalLogger: () => void;
}

const loggerInstallations = new Map<object, LoggerInstallation>();

interface InternalLoggerInstallation {
	rootLogger: RootLogger;
}

const internalLoggerInstallations: InternalLoggerInstallation[] = [];
let restoreInternalLoggerBridge: (() => void) | undefined;

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

const suppressDefault = () => undefined;
const commandDefaultSuppressors = {
	onBeforeMiddlewares: suppressDefault,
	onBeforeOptions: suppressDefault,
	onRunError: suppressDefault,
	onPermissionsFail: suppressDefault,
	onBotPermissionsFail: suppressDefault,
	onInternalError: suppressDefault,
	onMiddlewaresError: suppressDefault,
	onOptionsError: suppressDefault,
	onAfterRun: suppressDefault,
};
const componentDefaultSuppressors = {
	onBeforeMiddlewares: suppressDefault,
	onRunError: suppressDefault,
	onInternalError: suppressDefault,
	onMiddlewaresError: suppressDefault,
	onAfterRun: suppressDefault,
};

export function useLogger(owner?: object): WideEventLogger {
	const current = loggerScope.getStore();
	if (current) return current;
	const root = resolveRootLogger(owner);
	// Outside an interaction scope, hand back a fresh root-backed wide event: level
	// methods emit immediately, and add()/emit() let you build a one-off wide event.
	// Nothing auto-emits this one, so flag it to warn (dev) if add()-ed but never emitted.
	return root.eventWithOptions({}, { warnIfUnemitted: true });
}

export async function withLoggerScope<T>(data: LogData, run: () => Awaitable<T>, owner?: object): Promise<T> {
	const event = resolveRootLogger(owner).event(data);
	return loggerScope.run(event, async () => {
		try {
			const result = await run();
			await event.emit({ outcome: 'success' });
			return result;
		} catch (error) {
			await event.emit({ outcome: 'error', error });
			throw error;
		}
	});
}

export function logger(options: LoggerPluginOptions = {}) {
	const root = createLogger(options);
	const contextConfig = resolveContextConfig(options.context);
	const installations = new Map<object, LoggerInstallation>();
	const instrumentedHandlers = new WeakSet<object>();

	return createPlugin({
		name: '@slipher/logger',
		ctx: {
			logger: source => root.event(extractSeyfertLogContext(source, contextConfig)),
		},
		options() {
			return createLoggerPluginOptions(root, contextConfig);
		},
		register: api => {
			// Keep user hooks intact. Command observers run after the loaded command's own lifecycle hooks.
			api.commands.observe(createCommandObserver(root, contextConfig));
			api.handlers.transform(
				(instance, metadata) => {
					if (
						instance &&
						typeof instance === 'object' &&
						(metadata.kind === 'component' || metadata.kind === 'modal')
					) {
						instrumentComponentLifecycle(instance, metadata.kind, root, contextConfig, instrumentedHandlers);
					}
				},
				{ kinds: ['component', 'modal'] },
			);
			// Contributions must contain functions for suppressDefault to remove Seyfert's host FATAL fallbacks.
			api.commands.defaults(commandDefaultSuppressors, { suppressDefault: true });
			api.components.defaults(componentDefaultSuppressors, { suppressDefault: true });
			api.modals.defaults(componentDefaultSuppressors, { suppressDefault: true });
		},
		setup: (client, api) => {
			const existing = installations.get(client);
			disposeLoggerInstallation(existing);
			const installation = installSeyfertLoggerForPlugin(client, root);
			installations.set(client, installation);

			const instrumentCommands = () => instrumentLoadedCommands(client, root, contextConfig, instrumentedHandlers);
			const instrumentComponents = () => instrumentLoadedComponents(client, root, contextConfig, instrumentedHandlers);
			api?.hooks.on('commands:afterLoad', instrumentCommands);
			api?.hooks.on('components:afterLoad', instrumentComponents);
			instrumentCommands();
			instrumentComponents();
		},
		teardown: async client => {
			try {
				await root.flush();
			} finally {
				const installation = installations.get(client);
				disposeLoggerInstallation(installation);
				installations.delete(client);
			}
		},
	});
}

function createLoggerPluginOptions(
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
): SeyfertPluginOptions {
	return {
		contextScopes: [
			(context, run) => {
				const event = getScopedLogger(root, context, contextConfig);
				return loggerScope.run(event, async () => {
					let escaped = false;
					try {
						return await run();
					} catch (error) {
						escaped = true;
						rememberEscapedScope(error, event);
						throw error;
					} finally {
						if (!escaped) await event.emit({ outcome: 'skipped' });
					}
				});
			},
		],
	};
}

function resolveRootLogger(owner?: object): RootLogger {
	if (owner instanceof RootLogger) return owner;

	if (owner) {
		const source = asRecord(owner);
		const nestedClient = source.client;
		const client = nestedClient && typeof nestedClient === 'object' ? nestedClient : owner;
		const installation = loggerInstallations.get(client);
		if (installation) return installation.rootLogger;
		throw new Error('The provided client is not set up with @slipher/logger.');
	}

	const roots = new Set([...loggerInstallations.values()].map(installation => installation.rootLogger));
	if (roots.size === 1) return roots.values().next().value!;
	if (roots.size === 0) {
		throw new Error('Cannot access the logger before the @slipher/logger plugin is set up.');
	}
	throw new Error('Multiple @slipher/logger clients are active; pass the client explicitly to useLogger().');
}

function installSeyfertLoggerForPlugin<TClient extends SeyfertClientLike>(
	client: TClient,
	rootLogger: RootLogger,
): LoggerInstallation {
	const properties: InstalledLoggerProperty[] = [];
	setLoggerOn(client.commands, rootLogger, properties);
	setLoggerOn(client.components, rootLogger, properties);
	setLoggerOn(client.events, rootLogger, properties);
	setLoggerOn(client.langs, rootLogger, properties);
	setLoggerOn(client.cache, rootLogger, properties);
	setInternalLoggerOn(client.cache, rootLogger, properties);
	const installation = {
		client,
		rootLogger,
		properties,
		restoreInternalLogger: installSeyfertInternalLogger(rootLogger),
	};
	loggerInstallations.set(client, installation);
	return installation;
}

function restoreSeyfertLogger(installation: LoggerInstallation | undefined): void {
	if (!installation) return;
	if (loggerInstallations.get(installation.client) === installation) {
		loggerInstallations.delete(installation.client);
	}

	for (const property of installation.properties) {
		if (property.target[property.key] !== installation.rootLogger) continue;
		if (property.hadOwnValue) {
			property.target[property.key] = property.previousValue;
		} else {
			delete property.target[property.key];
		}
	}
}

function disposeLoggerInstallation(installation: LoggerInstallation | undefined): void {
	installation?.restoreInternalLogger();
	restoreSeyfertLogger(installation);
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
		customId: resolvedConfig.customId ? getString(source.customId ?? interaction.customId) : undefined,
		guildId: resolvedConfig.guildId ? getString(source.guildId ?? interaction.guildId) : undefined,
		channelId: resolvedConfig.channelId ? getString(source.channelId ?? interaction.channelId) : undefined,
		shardId: resolvedConfig.shardId ? getNumber(source.shardId ?? interaction.shardId) : undefined,
		userId: resolvedConfig.userId ? getString(author.id) : undefined,
		interactionId: resolvedConfig.interactionId
			? getString(source.interactionId ?? interaction.id ?? source.id)
			: undefined,
	});
}

function createCommandObserver(
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
): PluginCommandObserver {
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
		onMiddlewaresError: (context, reason) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'denied',
				message: 'command middleware denied',
				data: { reason },
			}),
		onAfterRun: (context, error) => closeRun(root, context, 'command', error, contextConfig),
	};
}

type LifecycleHook = (this: unknown, ...args: unknown[]) => unknown;

function instrumentLoadedCommands(
	client: SeyfertClientLike,
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
	instrumented: WeakSet<object>,
): void {
	const commands = asRecord(client.commands);
	for (const command of objectArray(commands.values)) {
		instrumentCommandFallbacks(command, root, contextConfig, instrumented);
	}
	const entryPoint = commands.entryPoint;
	if (entryPoint && typeof entryPoint === 'object') {
		instrumentCommandFallbacks(entryPoint, root, contextConfig, instrumented);
	}
}

function instrumentLoadedComponents(
	client: SeyfertClientLike,
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
	instrumented: WeakSet<object>,
): void {
	const components = asRecord(client.components);
	for (const component of objectArray(components.commands)) {
		instrumentComponentLifecycle(
			component,
			component instanceof ModalCommand ? 'modal' : 'component',
			root,
			contextConfig,
			instrumented,
		);
	}
}

function objectArray(value: unknown): object[] {
	return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

function instrumentCommandFallbacks(
	instance: object,
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
	instrumented: WeakSet<object>,
): void {
	if (instrumented.has(instance)) return;
	instrumented.add(instance);
	const target = instance as Record<string, unknown>;
	composeLifecycleHook(
		target,
		'onOptionsError',
		(context, metadata) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'error',
				message: 'command options failed',
				data: { metadata },
			}),
		{ installIfMissing: false },
	);
	composeLifecycleHook(
		target,
		'onPermissionsFail',
		(context, permissions) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'denied',
				level: 'warn',
				message: 'command permission denied',
				data: { permissions },
			}),
		{ installIfMissing: false },
	);
	composeLifecycleHook(
		target,
		'onBotPermissionsFail',
		(context, permissions) =>
			getContextLogger(root, context, 'command', contextConfig).emit({
				outcome: 'denied',
				level: 'warn',
				message: 'bot permission denied',
				data: { permissions },
			}),
		{ installIfMissing: false },
	);
	composeLifecycleHook(
		target,
		'onInternalError',
		(_client, command, error) => emitInternalError(root, 'command', command, error),
		{ always: true, installIfMissing: false },
	);

	const options = target.options;
	if (!Array.isArray(options)) return;
	for (const option of options) {
		if (option && typeof option === 'object') {
			instrumentCommandFallbacks(option, root, contextConfig, instrumented);
		}
	}
}

function instrumentComponentLifecycle(
	instance: object,
	kind: 'component' | 'modal',
	root: RootLogger,
	contextConfig: Record<AutoContextField, boolean>,
	instrumented: WeakSet<object>,
): void {
	if (instrumented.has(instance)) return;
	instrumented.add(instance);
	const target = instance as Record<string, unknown>;
	composeLifecycleHook(target, 'onBeforeMiddlewares', context => {
		return getContextLogger(root, context, kind, contextConfig).debug(`${kind} received`);
	});
	composeLifecycleHook(target, 'onRunError', (context, error) =>
		getContextLogger(root, context, kind, contextConfig).emit({
			outcome: 'error',
			message: `${kind} failed`,
			error,
		}),
	);
	composeLifecycleHook(target, 'onMiddlewaresError', (context, reason) =>
		getContextLogger(root, context, kind, contextConfig).emit({
			outcome: 'denied',
			message: `${kind} middleware denied`,
			data: { reason },
		}),
	);
	composeLifecycleHook(
		target,
		'onInternalError',
		(_client, command, error) => emitInternalError(root, kind, command, error),
		{
			always: true,
		},
	);
	composeLifecycleHook(target, 'onAfterRun', (context, error) => closeRun(root, context, kind, error, contextConfig));
}

function composeLifecycleHook(
	target: Record<string, unknown>,
	key: string,
	instrument: (...args: unknown[]) => Awaitable<void>,
	options: { always?: boolean; installIfMissing?: boolean } = {},
): void {
	const existing = target[key];
	if (typeof existing !== 'function' && options.installIfMissing === false) return;
	const original = typeof existing === 'function' ? (existing as LifecycleHook) : undefined;

	target[key] = async function (this: unknown, ...args: unknown[]) {
		if (!options.always) {
			const result = await original?.apply(this, args);
			await instrument(...args);
			return result;
		}

		let result: unknown;
		try {
			result = await original?.apply(this, args);
		} catch (error) {
			try {
				await instrument(...args);
			} finally {
				throw error;
			}
		}
		await instrument(...args);
		return result;
	};
}

function emitInternalError(
	root: RootLogger,
	kind: 'command' | 'component' | 'modal',
	command: unknown,
	error: unknown,
): Awaitable<void> {
	const data = stripUndefined({
		kind,
		command: kind === 'command' ? getStringField(command, 'name') : undefined,
		customId: kind === 'command' ? undefined : getStringField(command, 'customId'),
	});
	const scopedLogger = loggerScope.getStore() ?? takeEscapedScope(error);
	if (scopedLogger) {
		scopedLogger.add(data);
		return scopedLogger.emit({ outcome: 'error', message: `${kind} internal error`, error });
	}
	return root.error(withError(data, error), `${kind} internal error`);
}

function rememberEscapedScope(error: unknown, event: WideEventLogger): void {
	if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
		const queue = escapedObjectScopes.get(error) ?? [];
		queue.push(event);
		escapedObjectScopes.set(error, queue);
		return;
	}

	const queue = escapedPrimitiveScopes.get(error) ?? [];
	queue.push(event);
	escapedPrimitiveScopes.set(error, queue);
	const timeout = setTimeout(() => removeEscapedPrimitiveScope(error, event), 0);
	timeout.unref?.();
}

function takeEscapedScope(error: unknown): WideEventLogger | undefined {
	const objectKey = (typeof error === 'object' && error !== null) || typeof error === 'function';
	const queue = objectKey ? escapedObjectScopes.get(error as object) : escapedPrimitiveScopes.get(error);
	const event = queue?.shift();
	if (!queue?.length) {
		if (objectKey) escapedObjectScopes.delete(error as object);
		else escapedPrimitiveScopes.delete(error);
	}
	return event;
}

function removeEscapedPrimitiveScope(error: unknown, event: WideEventLogger): void {
	const queue = escapedPrimitiveScopes.get(error);
	if (!queue) return;
	const index = queue.indexOf(event);
	if (index !== -1) queue.splice(index, 1);
	if (!queue.length) escapedPrimitiveScopes.delete(error);
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

function setLoggerOn(target: unknown, rootLogger: RootLogger, properties: InstalledLoggerProperty[] = []): void {
	if (!target || typeof target !== 'object') return;
	setLoggerProperty(target, 'logger', rootLogger, properties);
}

function setInternalLoggerOn(
	target: unknown,
	rootLogger: RootLogger,
	properties: InstalledLoggerProperty[] = [],
): void {
	if (!target || typeof target !== 'object') return;
	setLoggerProperty(target, '__logger__', rootLogger, properties);
}

function setLoggerProperty(
	target: object,
	key: 'logger' | '__logger__',
	rootLogger: RootLogger,
	properties: InstalledLoggerProperty[],
): void {
	const record = target as Record<string, unknown>;
	properties.push({
		target: record,
		key,
		hadOwnValue: Object.prototype.hasOwnProperty.call(record, key),
		previousValue: record[key],
	});
	record[key] = rootLogger;
}

function installSeyfertInternalLogger(root: RootLogger): () => void {
	const installation = { rootLogger: root };
	internalLoggerInstallations.push(installation);

	if (!restoreInternalLoggerBridge) {
		const previous = SeyfertLogger.getCustomizer();
		restoreInternalLoggerBridge = SeyfertLogger.customize((self, level, args) => {
			const roots = new Set(internalLoggerInstallations.map(item => item.rootLogger));
			const activeRoot = roots.size === 1 ? roots.values().next().value : undefined;
			if (activeRoot) {
				void activeRoot.writeEntry({
					level: mapSeyfertLogLevel(level),
					time: activeRoot.timestamp(),
					bindings: {},
					data: buildSeyfertInternalLogData(self, args),
					message: formatSeyfertLogMessage(args),
				});
			}

			return previous(self, level, args);
		});
	}

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const index = internalLoggerInstallations.indexOf(installation);
		if (index !== -1) internalLoggerInstallations.splice(index, 1);
		if (internalLoggerInstallations.length) return;

		const restore = restoreInternalLoggerBridge;
		restoreInternalLoggerBridge = undefined;
		restore?.();
	};
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
