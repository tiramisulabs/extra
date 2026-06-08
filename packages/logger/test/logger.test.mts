import { initLogger } from 'evlog';
import { Logger as SeyfertLogger } from 'seyfert';
import { LogLevels } from 'seyfert/lib/common';
import { assert, describe, test } from 'vitest';
import {
	ConsoleLoggerAdapter,
	createEvlogAdapter,
	createLogger,
	createPinoAdapter,
	extractSeyfertLogContext,
	type LogEntry,
	type LoggerAdapter,
	type LoggerPlugin,
	logger,
	type RootLogger,
	runInLoggerScope,
	useLogger,
	type WideEventLogger,
	withLoggerScope,
} from '../src';

class RecordingAdapter implements LoggerAdapter {
	readonly entries: LogEntry[] = [];
	flushes = 0;

	write(entry: LogEntry): void {
		this.entries.push(entry);
	}

	flush(): void {
		this.flushes++;
	}
}

class BlockingAdapter extends RecordingAdapter {
	private releaseWrite?: () => void;
	private readonly pendingWrite = new Promise<void>(resolve => {
		this.releaseWrite = resolve;
	});

	override write(entry: LogEntry): Promise<void> {
		this.entries.push(entry);
		return this.pendingWrite;
	}

	release(): void {
		this.releaseWrite?.();
	}
}

function commandContext(loggerInstance: WideEventLogger) {
	return {
		logger: loggerInstance,
		fullCommandName: 'admin ban',
		guildId: 'guild-1',
		channelId: 'channel-1',
		shardId: 2,
		author: { id: 'user-1', username: 'Socram' },
		interaction: { id: 'interaction-1', locale: 'es-ES' },
	};
}

describe('logger plugin', () => {
	test('returns a structural Seyfert plugin with context and lifecycle defaults', () => {
		const plugin: LoggerPlugin = logger({ adapter: new RecordingAdapter() });
		const options = plugin.options?.({});

		assert.equal(plugin.name, '@slipher/logger');
		assert.equal(typeof plugin.setup, 'function');
		assert.equal(typeof options?.context, 'function');
		assert.equal(typeof options?.commands?.defaults?.onAfterRun, 'function');
		assert.equal(typeof options?.components?.defaults?.onAfterRun, 'function');
		assert.equal(typeof options?.modals?.defaults?.onAfterRun, 'function');
	});

	test('level methods emit immediately and wide events contain no logs array', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({
			adapter,
			now: clock([
				new Date('2026-05-29T10:00:00.000Z'),
				new Date('2026-05-29T10:00:00.042Z'),
				new Date('2026-05-29T10:00:00.100Z'),
			]),
		});
		const options = plugin.options?.({});
		const extension = options?.context?.({
			id: 'interaction-1',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 2,
			user: { id: 'user-1', username: 'Socram' },
		}) as { logger: WideEventLogger };

		extension.logger.add({ actorRole: 'admin' });
		extension.logger.warn('target not in guild', { targetUser: 'user-2' });

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'warn');
		assert.equal(adapter.entries[0].message, 'target not in guild');
		assert.deepEqual(adapter.entries[0].data, { targetUser: 'user-2' });
		assert.equal('command' in adapter.entries[0].data, false);

		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);

		assert.equal(adapter.entries.length, 2);
		assert.equal(adapter.entries[1].level, 'info');
		assert.equal(adapter.entries[1].message, 'command completed');
		assert.deepEqual(adapter.entries[1].data, {
			actorRole: 'admin',
			channelId: 'channel-1',
			command: 'admin ban',
			durationMs: 100,
			guildId: 'guild-1',
			interactionId: 'interaction-1',
			kind: 'command',
			outcome: 'success',
			userId: 'user-1',
		});
		assert.equal('logs' in adapter.entries[1], false);
		assert.equal('levelValue' in adapter.entries[1], false);
	});

	test('currentContext returns a frozen copy for opt-in enriched immediate logs', async () => {
		const adapter = new RecordingAdapter();
		const root = createLogger({ adapter });
		const event = root.event({ command: 'ping' });

		event.add({ requestId: 'req-1' });
		const context = event.currentContext;
		assert.deepEqual(context, { command: 'ping', requestId: 'req-1' });
		assert.equal(Object.isFrozen(context), true);

		event.info('with context', context);

		assert.equal(adapter.entries.length, 1);
		assert.deepEqual(adapter.entries[0].data, { command: 'ping', requestId: 'req-1' });
	});

	test('context extraction is configurable and excludes noisy fields by default', () => {
		const source = {
			fullCommandName: 'image anime',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 2,
			author: { id: 'user-1', username: 'Socram' },
			interaction: { id: 'interaction-1', locale: 'es-ES' },
		};

		assert.deepEqual(extractSeyfertLogContext(source), {
			channelId: 'channel-1',
			command: 'image anime',
			guildId: 'guild-1',
			interactionId: 'interaction-1',
			userId: 'user-1',
		});
		assert.deepEqual(extractSeyfertLogContext(source, { shardId: true, channelId: false }), {
			command: 'image anime',
			guildId: 'guild-1',
			interactionId: 'interaction-1',
			shardId: 2,
			userId: 'user-1',
		});
	});

	test('extracts a camelCase Seyfert context and ignores raw snake_case payloads', () => {
		// Mirrors Seyfert's component/modal context: camelCase getters, customId off the interaction.
		// A lock against Seyfert renames — if a field name changes, this fails instead of degrading silently.
		const componentContext = {
			customId: 'confirm:1',
			guildId: 'guild-1',
			channelId: 'channel-1',
			author: { id: 'user-1' },
			interaction: { id: 'interaction-1' },
		};

		assert.deepEqual(extractSeyfertLogContext(componentContext), {
			channelId: 'channel-1',
			customId: 'confirm:1',
			guildId: 'guild-1',
			interactionId: 'interaction-1',
			userId: 'user-1',
		});

		// Seyfert hands camelCase contexts; raw Discord snake_case is intentionally not read.
		assert.deepEqual(extractSeyfertLogContext({ guild_id: 'g', channel_id: 'c', custom_id: 'x' }), {});
	});

	test('explicit add fields can include username even though auto extraction does not', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const extension = options?.context?.({
			id: 'interaction-1',
			user: { id: 'user-1', username: 'auto-noise' },
		}) as { logger: WideEventLogger };

		extension.logger.add({ username: 'manual' });
		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);

		assert.equal(adapter.entries[0].data.username, 'manual');
	});

	test('guards concurrent command emits while the adapter write is pending', async () => {
		const adapter = new BlockingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1' }) as { logger: WideEventLogger };

		const first = options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);
		const second = options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);

		await Promise.resolve();

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].message, 'command completed');

		adapter.release();
		await Promise.all([first, second]);

		assert.equal(adapter.entries.length, 1);
	});

	test('command run errors emit a single wide event with context, not a duplicate immediate log', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1', guildId: 'guild-1' }) as { logger: WideEventLogger };
		const context = commandContext(extension.logger);
		const error = new Error('boom');

		await options?.commands?.defaults?.onRunError?.(context, error);
		await options?.commands?.defaults?.onAfterRun?.(context, error);

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'error');
		assert.equal(adapter.entries[0].message, 'command failed');
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].data.error, error);
		assert.equal(adapter.entries[0].data.command, 'admin ban');
	});

	test('setup installs the logger on Seyfert subsystems and flushes on teardown', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const client = {
			commands: {},
			components: {},
			events: {},
			langs: {},
			cache: {},
		};

		await plugin.setup?.(client);
		const rootLogger = client.commands.logger as RootLogger;

		assert.equal(client.components.logger, rootLogger);
		assert.equal(client.events.logger, rootLogger);
		assert.equal(client.langs.logger, rootLogger);
		assert.equal(client.cache.logger, rootLogger);
		assert.equal(client.cache.__logger__, rootLogger);

		await useLogger().info('member joined', { memberId: 'user-1' });

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].message, 'member joined');
		assert.deepEqual(adapter.entries[0].data, { memberId: 'user-1' });

		await plugin.teardown?.(client);
		assert.equal(adapter.flushes, 1);
	});

	test('useLogger works outside an interaction scope, immediate and as a one-off wide event', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		await plugin.setup?.({ commands: {}, components: {}, events: {}, langs: {}, cache: {} });

		await useLogger().info('ready');
		assert.equal(adapter.entries[0].message, 'ready');

		const event = useLogger();
		event.add({ source: 'event', interactionId: 'interaction-1' });
		await event.emit({ message: 'interactionCreate received' });

		assert.equal(adapter.entries.length, 2);
		assert.equal(adapter.entries[1].message, 'interactionCreate received');
		assert.equal(adapter.entries[1].data.source, 'event');
		assert.equal(adapter.entries[1].data.interactionId, 'interaction-1');
		assert.equal(adapter.entries[1].data.outcome, 'success');
	});

	test('runInLoggerScope binds an event so useLogger() resolves to it', () => {
		const adapter = new RecordingAdapter();
		const root = createLogger({ adapter });
		const event = root.event({ kind: 'job' });

		runInLoggerScope(event, () => {
			assert.equal(useLogger(), event);
			useLogger().add({ jobId: 'job-1' });
		});

		assert.equal(event.currentContext.jobId, 'job-1');
	});

	test('withLoggerScope scopes a unit of work and emits one wide event on success', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		await plugin.setup?.({ commands: {}, components: {}, events: {}, langs: {}, cache: {} });

		const result = await withLoggerScope({ kind: 'job', jobId: 'job-1' }, () => {
			useLogger().add({ processed: 2 });
			return 'done';
		});

		assert.equal(result, 'done');
		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.kind, 'job');
		assert.equal(adapter.entries[0].data.jobId, 'job-1');
		assert.equal(adapter.entries[0].data.processed, 2);
		assert.equal(adapter.entries[0].data.outcome, 'success');
	});

	test('withLoggerScope emits an error wide event and rethrows on failure', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		await plugin.setup?.({ commands: {}, components: {}, events: {}, langs: {}, cache: {} });
		const boom = new Error('boom');

		let thrown: unknown;
		try {
			await withLoggerScope({ kind: 'job' }, () => {
				throw boom;
			});
		} catch (error) {
			thrown = error;
		}

		assert.equal(thrown, boom);
		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].data.error, boom);
	});

	test('setup routes Seyfert internal logs through the adapter and preserves existing customizers', async () => {
		const adapter = new RecordingAdapter();
		const chained: unknown[][] = [];
		const originalLog = console.log;
		console.log = () => undefined;
		SeyfertLogger.customize((self, level, args) => {
			chained.push([self.name, level, args]);
			return args;
		});

		try {
			const plugin = logger({ adapter, now: () => new Date('2026-05-29T10:00:00.000Z') });
			await plugin.setup?.({ commands: {}, components: {}, events: {}, langs: {}, cache: {} });

			new SeyfertLogger({ name: '[API]', active: true }).info('identify', { requestId: 'req-1' });
			new SeyfertLogger({ name: '[Gateway]', active: true }).error('lost shard', new Error('socket closed'));
		} finally {
			SeyfertLogger.customize((_self, _level, args) => args);
			console.log = originalLog;
		}

		assert.equal(adapter.entries.length, 2);
		assert.equal(adapter.entries[0].level, 'info');
		assert.equal(adapter.entries[0].message, 'identify');
		assert.deepEqual(adapter.entries[0].data, { _source: 'seyfert:API', details: { requestId: 'req-1' } });
		assert.equal(adapter.entries[1].level, 'error');
		assert.equal(adapter.entries[1].message, 'lost shard');
		assert.equal(adapter.entries[1].data._source, 'seyfert:Gateway');
		assert.instanceOf(adapter.entries[1].data.err, Error);
		assert.equal(chained.length, 2);
		assert.deepEqual(chained[0], ['[API]', LogLevels.Info, ['identify', { requestId: 'req-1' }]]);
		assert.equal(chained[1]?.[0], '[Gateway]');
		assert.equal(chained[1]?.[1], LogLevels.Error);
		assert.equal((chained[1]?.[2] as unknown[])?.[0], 'lost shard');
		assert.instanceOf((chained[1]?.[2] as unknown[])?.[1], Error);
	});

	test('useLogger exposes the current command logger without passing context', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter, level: 'debug' });
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1' }) as { logger: WideEventLogger };
		const context = commandContext(extension.logger);

		await options?.contextScopes?.[0]?.(context, async () => {
			await options?.commands?.defaults?.onBeforeMiddlewares?.(context);
			const scopedLogger = useLogger();

			assert.equal(scopedLogger, extension.logger);

			scopedLogger.add({ serviceUser: 'user-1' });
			scopedLogger.info('loaded user service');

			await options?.commands?.defaults?.onAfterRun?.(context, undefined);
		});

		assert.equal(adapter.entries.length, 3);
		assert.deepEqual(
			adapter.entries.map(entry => entry.message),
			['command received', 'loaded user service', 'command completed'],
		);
		assert.equal(adapter.entries[2].data.serviceUser, 'user-1');
	});

	test('context scopes do not mutate Seyfert contexts with logger fields', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const context = { fullCommandName: 'ping' };

		await options?.contextScopes?.[0]?.(context, async () => {
			useLogger().add({ requestId: 'request-1' });
			await options?.commands?.defaults?.onAfterRun?.(context, undefined);
		});

		assert.equal('logger' in context, false);
		assert.equal(adapter.entries[0].data.command, 'ping');
		assert.equal(adapter.entries[0].data.requestId, 'request-1');
	});

	test('generic context extension does not hard-code command kind for components', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const extension = options?.context?.({ customId: 'button:confirm' }) as { logger: WideEventLogger };

		assert.equal(extension.logger.currentContext.kind, undefined);

		await options?.components?.defaults?.onAfterRun?.(
			{ logger: extension.logger, customId: 'button:confirm' },
			undefined,
		);

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.kind, 'component');
		assert.equal(adapter.entries[0].data.customId, 'button:confirm');
	});
});

describe('logger adapters', () => {
	test('ConsoleLoggerAdapter writes pretty text by default with user data winning collisions', () => {
		const calls: unknown[][] = [];
		const originalNoColor = process.env.NO_COLOR;
		const originalInfo = console.info;
		process.env.NO_COLOR = '1';
		console.info = (...args: unknown[]) => {
			calls.push(args);
		};

		try {
			new ConsoleLoggerAdapter().write({
				bindings: { name: 'bot', shardId: 1 },
				data: { guildId: 'guild-1', level: 'critical', message: 'override' },
				level: 'info',
				message: 'ready',
				time: new Date('2026-05-29T10:00:00.000Z'),
			});
		} finally {
			if (originalNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = originalNoColor;
			console.info = originalInfo;
		}

		assert.equal(calls.length, 1);
		assert.equal(calls[0].length, 1);
		assert.equal(calls[0][0], '10:00:00.000 CRITICAL [bot] override\n    shardId   1\n    guildId   guild-1');
	});

	test('ConsoleLoggerAdapter colorizes by level and appends error stacks when color is enabled', () => {
		const calls: unknown[][] = [];
		const originalNoColor = process.env.NO_COLOR;
		const originalForceColor = process.env.FORCE_COLOR;
		const originalError = console.error;
		delete process.env.NO_COLOR;
		process.env.FORCE_COLOR = '1';
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};
		const error = new Error('socket closed');

		try {
			new ConsoleLoggerAdapter().write({
				bindings: {},
				data: { command: 'ban', err: error },
				level: 'error',
				message: 'command failed',
				time: new Date('2026-05-29T10:00:00.000Z'),
			});
		} finally {
			if (originalNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = originalNoColor;
			if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
			else process.env.FORCE_COLOR = originalForceColor;
			console.error = originalError;
		}

		const output = calls[0][0] as string;
		assert.equal(calls.length, 1);
		assert.ok(output.includes('ERROR\x1b[0m'), 'level label is colorized');
		assert.ok(output.includes('command failed'), 'message rendered');
		assert.ok(output.includes('command\x1b[0m'), 'field key colorized in its own column');
		assert.ok(output.includes('    Error: socket closed'), 'error stack indented on following lines');
		assert.equal(output.includes('err\x1b[0m'), false, 'error not rendered as a field');
	});

	test('ConsoleLoggerAdapter writes JSON in production', () => {
		const calls: unknown[][] = [];
		const originalEnv = process.env.NODE_ENV;
		const originalInfo = console.info;
		process.env.NODE_ENV = 'production';
		console.info = (...args: unknown[]) => {
			calls.push(args);
		};

		try {
			new ConsoleLoggerAdapter().write({
				bindings: { name: 'bot' },
				data: { guildId: 'guild-1' },
				level: 'info',
				message: 'ready',
				time: new Date('2026-05-29T10:00:00.000Z'),
			});
		} finally {
			if (originalEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = originalEnv;
			console.info = originalInfo;
		}

		assert.equal(calls.length, 1);
		assert.equal(
			calls[0][0],
			JSON.stringify({
				time: '2026-05-29T10:00:00.000Z',
				level: 'info',
				message: 'ready',
				name: 'bot',
				guildId: 'guild-1',
			}),
		);
	});

	test('ConsoleLoggerAdapter serializes Error fields in production JSON', () => {
		const calls: unknown[][] = [];
		const originalEnv = process.env.NODE_ENV;
		const originalError = console.error;
		process.env.NODE_ENV = 'production';
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};

		try {
			new ConsoleLoggerAdapter().write({
				bindings: {},
				data: { error: new Error('Missing Permissions') },
				level: 'error',
				message: 'command failed',
				time: new Date('2026-05-29T10:00:00.000Z'),
			});
		} finally {
			if (originalEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = originalEnv;
			console.error = originalError;
		}

		const parsed = JSON.parse(calls[0][0] as string);
		assert.equal(parsed.error.name, 'Error');
		assert.equal(parsed.error.message, 'Missing Permissions');
		assert.equal(typeof parsed.error.stack, 'string');
	});

	test('createPinoAdapter sends only event data and uses child bindings', async () => {
		const childCalls: unknown[] = [];
		const calls: unknown[][] = [];
		const target = {
			child(bindings: Record<string, unknown>) {
				childCalls.push(bindings);
				return this;
			},
			info: (...args: unknown[]) => calls.push(args),
		};
		const adapter = createPinoAdapter(target).child?.({ name: 'bot', shardId: 1 }) ?? createPinoAdapter(target);

		await adapter.write({
			bindings: { name: 'bot', shardId: 1 },
			data: { guildId: 'guild-1' },
			level: 'info',
			message: 'ready',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});

		assert.deepEqual(childCalls, [{ name: 'bot', shardId: 1 }]);
		assert.deepEqual(calls, [[{ guildId: 'guild-1' }, 'ready']]);
	});

	test('createEvlogAdapter routes entries through the evlog global pipeline', async () => {
		const events: Array<Record<string, unknown>> = [];
		initLogger({
			_suppressDrainWarning: true,
			silent: true,
			redact: { paths: ['secret'], builtins: false },
			drain(context) {
				events.push(context.event as Record<string, unknown>);
			},
		});
		const adapter = createEvlogAdapter();

		await adapter.write({
			bindings: { service: 'bot' },
			data: {
				command: 'deploy',
				interactionId: 'interaction-1',
				kind: 'command',
				secret: 'token',
			},
			level: 'info',
			message: 'command completed',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});
		await flushEvlogDrain();

		assert.equal(events.length, 1);
		assert.equal(events[0]!.command, 'deploy');
		assert.equal(events[0]!.message, 'command completed');
		assert.equal('method' in events[0]!, false);
		assert.equal(events[0]!.secret, '[REDACTED]');
		assert.equal('status' in events[0]!, false);
	});

	test('createEvlogAdapter emits warn lifecycle entries as wide events without fake HTTP fields', async () => {
		const events: Array<Record<string, unknown>> = [];
		initLogger({
			_suppressDrainWarning: true,
			silent: true,
			drain(context) {
				events.push(context.event as Record<string, unknown>);
			},
		});
		const adapter = createEvlogAdapter();

		await adapter.write({
			bindings: {},
			data: {
				durationMs: 12,
				kind: 'command',
				outcome: 'denied',
			},
			level: 'warn',
			message: 'command permission denied',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});
		await flushEvlogDrain();

		assert.equal(events.length, 1);
		assert.equal('status' in events[0]!, false);
		assert.equal('method' in events[0]!, false);
	});

	test('createEvlogAdapter uses the tagged form for simple entries, folding name into the tag', async () => {
		const events: Array<Record<string, unknown>> = [];
		initLogger({
			_suppressDrainWarning: true,
			silent: true,
			drain(context) {
				events.push(context.event as Record<string, unknown>);
			},
		} as never);
		const adapter = createEvlogAdapter();

		await adapter.write({
			bindings: { name: 'tohka-bot' },
			data: {},
			level: 'info',
			message: 'Tohka is ready',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});
		await flushEvlogDrain();

		assert.equal(events.length, 1);
		assert.equal(events[0]!.tag, 'tohka-bot');
		assert.equal(events[0]!.message, 'Tohka is ready');
		assert.equal('name' in events[0]!, false);
	});
});

describe('createLogger', () => {
	test('writes immediate root logs and supports child bindings', async () => {
		const adapter = new RecordingAdapter();
		const root = createLogger({ adapter, bindings: { app: 'bot' } }).child({ shardId: 1 });
		const error = new Error('boom');

		await root.error({ route: '/sync' }, 'sync failed', error);

		assert.equal(adapter.entries.length, 1);
		assert.deepEqual(adapter.entries[0].bindings, { app: 'bot', shardId: 1 });
		assert.deepEqual(adapter.entries[0].data, { route: '/sync', error });
		assert.equal(adapter.entries[0].message, 'sync failed');
		assert.equal('levelValue' in adapter.entries[0], false);
	});

	test('stores root name as a binding', async () => {
		const adapter = new RecordingAdapter();
		const root = createLogger({ adapter, bindings: { app: 'bot' }, name: 'slipher-bot' }).child({ shardId: 1 });
		const event = root.event({ job: 'sync-guild' });

		await event.emit({ message: 'guild sync completed' });

		assert.equal(adapter.entries.length, 1);
		assert.equal('name' in adapter.entries[0], false);
		assert.deepEqual(adapter.entries[0].bindings, { name: 'slipher-bot', app: 'bot', shardId: 1 });
	});

	test('reports adapter write failures without rejecting callers', async () => {
		const calls: unknown[][] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			calls.push(args);
		};

		try {
			const syncError = new Error('sync sink failed');
			const asyncError = new Error('async sink failed');
			const syncLogger = createLogger({
				adapter: {
					write() {
						throw syncError;
					},
				},
			});
			const asyncLogger = createLogger({
				adapter: {
					write() {
						return Promise.reject(asyncError);
					},
				},
			});

			let thrown: unknown;
			try {
				await syncLogger.info('sync failure');
				await asyncLogger.info('async failure');
			} catch (error) {
				thrown = error;
			}

			assert.equal(thrown, undefined);
		} finally {
			console.error = originalError;
		}

		assert.deepEqual(calls, [
			['[logger] adapter.write failed:', new Error('sync sink failed')],
			['[logger] adapter.write failed:', new Error('async sink failed')],
		]);
	});
});

function clock(values: Date[]): () => Date {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}

async function flushEvlogDrain(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0));
}
