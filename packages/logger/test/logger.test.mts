import { assert, describe, test } from 'vitest';
import {
	ConsoleLoggerAdapter,
	createEvlogDrainAdapter,
	createLogger,
	createPinoLoggerAdapter,
	extractSeyfertLogContext,
	type LogEntry,
	type LoggerAdapter,
	type LoggerPlugin,
	logger,
	type RootLogger,
	useLogger,
	type WideEventLogger,
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

	test('keeps command logs in memory and emits one wide event after completion', async () => {
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
			locale: 'es-ES',
			user: { id: 'user-1', username: 'Socram' },
		}) as { logger: WideEventLogger };

		extension.logger.add({ actorRole: 'admin' });
		extension.logger.warn('target not in guild', { targetUser: 'user-2' });

		assert.equal(adapter.entries.length, 0);

		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'warn');
		assert.equal(adapter.entries[0].message, 'command completed');
		assert.deepEqual(adapter.entries[0].data, {
			actorRole: 'admin',
			channelId: 'channel-1',
			command: 'admin ban',
			durationMs: 100,
			guildId: 'guild-1',
			interactionId: 'interaction-1',
			kind: 'command',
			locale: 'es-ES',
			outcome: 'success',
			shardId: 2,
			targetUser: 'user-2',
			userId: 'user-1',
			username: 'Socram',
		});
		assert.deepEqual(
			adapter.entries[0].logs.map(record => record.message),
			['target not in guild'],
		);
		assert.equal(adapter.entries[0].logs[0].level, 'warn');
		assert.deepEqual(adapter.entries[0].logs[0].data, { targetUser: 'user-2' });
	});

	test('emits command errors once and preserves unredacted fields', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({
			adapter,
			now: clock([new Date('2026-05-29T10:00:00.000Z'), new Date('2026-05-29T10:00:00.010Z')]),
		});
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1', token: 'keep-me' }) as { logger: WideEventLogger };
		const error = new Error('Missing Permissions');

		extension.logger.add({ token: 'keep-me' });
		await options?.commands?.defaults?.onRunError?.(commandContext(extension.logger), error);
		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), error);
		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), error);

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'error');
		assert.equal(adapter.entries[0].message, 'command failed');
		assert.equal(adapter.entries[0].data.outcome, 'error');
		assert.equal(adapter.entries[0].data.token, 'keep-me');
		assert.equal(adapter.entries[0].data.error, error);
		assert.equal(adapter.entries[0].logs.length, 1);
		assert.equal(adapter.entries[0].logs[0].message, 'command failed');
		assert.equal(adapter.entries[0].logs[0].data.error, error);
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

	test('closes terminal hooks that do not reach onAfterRun', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1' }) as { logger: WideEventLogger };

		await options?.commands?.defaults?.onPermissionsFail?.(commandContext(extension.logger), ['ManageGuild']);
		await options?.commands?.defaults?.onAfterRun?.(commandContext(extension.logger), undefined);

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'warn');
		assert.equal(adapter.entries[0].message, 'command permission denied');
		assert.equal(adapter.entries[0].data.outcome, 'denied');
		assert.deepEqual(adapter.entries[0].data.permissions, ['ManageGuild']);
	});

	test('setup installs the root logger on the client and Seyfert handlers', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const client = {
			logger: undefined,
			commands: {},
			components: {},
			events: {},
			langs: {},
			cache: {},
		};

		await plugin.setup?.(client);
		const rootLogger = client.logger as RootLogger;

		assert.equal(client.slipherLogger, rootLogger);
		assert.equal(client.commands.logger, rootLogger);
		assert.equal(client.components.logger, rootLogger);
		assert.equal(client.events.logger, rootLogger);
		assert.equal(client.langs.logger, rootLogger);
		assert.equal(client.cache.logger, rootLogger);
		assert.equal(client.cache.__logger__, rootLogger);

		await rootLogger.info('member joined', { memberId: 'user-1' });

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].message, 'member joined');
		assert.deepEqual(adapter.entries[0].data, { memberId: 'user-1' });
	});

	test('useLogger exposes the current command logger without passing context', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter, level: 'debug' });
		const options = plugin.options?.({});
		const extension = options?.context?.({ id: 'interaction-1' }) as { logger: WideEventLogger };
		const context = commandContext(extension.logger);

		assert.throws(() => useLogger(), /outside of a Seyfert logger scope/);

		await options?.contextScopes?.[0]?.(context, async () => {
			await options?.commands?.defaults?.onBeforeMiddlewares?.(context);
			const scopedLogger = useLogger();

			assert.equal(scopedLogger, extension.logger);

			scopedLogger.add({ serviceUser: 'user-1' });
			scopedLogger.info('loaded user service');

			await options?.commands?.defaults?.onAfterRun?.(context, undefined);
		});

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].data.serviceUser, 'user-1');
		assert.deepEqual(
			adapter.entries[0].logs.map(record => record.message),
			['command received', 'loaded user service'],
		);
		assert.throws(() => useLogger(), /outside of a Seyfert logger scope/);
	});

	test('useLogger keeps concurrent command scopes isolated', async () => {
		const adapter = new RecordingAdapter();
		const plugin = logger({ adapter });
		const options = plugin.options?.({});

		async function runScopedCommand(id: string) {
			const extension = options?.context?.({ id }) as { logger: WideEventLogger };
			const context = commandContext(extension.logger);

			await options?.contextScopes?.[0]?.(context, async () => {
				await options?.commands?.defaults?.onBeforeMiddlewares?.(context);
				await Promise.resolve();
				useLogger().add({ interaction: id });
				await options?.commands?.defaults?.onAfterRun?.(context, undefined);
			});
		}

		await Promise.all([runScopedCommand('interaction-1'), runScopedCommand('interaction-2')]);

		assert.deepEqual(adapter.entries.map(entry => entry.data.interaction).sort(), ['interaction-1', 'interaction-2']);
	});
});

describe('logger adapters', () => {
	test('ConsoleLoggerAdapter implements the adapter contract', () => {
		const adapter: LoggerAdapter = new ConsoleLoggerAdapter();

		assert.equal(typeof adapter.write, 'function');
	});

	test('createPinoLoggerAdapter delegates structurally without adding a dependency', async () => {
		const calls: unknown[][] = [];
		const adapter = createPinoLoggerAdapter({
			info: (...args: unknown[]) => calls.push(args),
		});

		await adapter.write({
			bindings: {},
			data: { guildId: 'guild-1' },
			level: 'info',
			levelValue: 30,
			logs: [],
			message: 'ready',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0][0], {
			bindings: {},
			data: { guildId: 'guild-1' },
			level: 'info',
			levelValue: 30,
			logs: [],
			time: new Date('2026-05-29T10:00:00.000Z'),
		});
		assert.equal(calls[0][1], 'ready');
	});

	test('createEvlogDrainAdapter converts entries into evlog drain contexts', async () => {
		const contexts: unknown[] = [];
		let flushes = 0;
		const drain = Object.assign((context: unknown) => contexts.push(context), {
			flush: () => {
				flushes++;
			},
		});
		const adapter = createEvlogDrainAdapter(drain, {
			environment: 'test',
			version: '1.2.3',
		});

		await adapter.write({
			bindings: { shardId: 1 },
			data: { guildId: 'guild-1', ready: true },
			level: 'fatal',
			levelValue: 60,
			logs: [{ data: { step: 'boot' }, level: 'trace', levelValue: 10, time: new Date('2026-05-29T10:00:00.010Z') }],
			message: 'ready',
			name: 'slipher-bot',
			time: new Date('2026-05-29T10:00:00.000Z'),
		});
		await adapter.flush?.();

		assert.equal(contexts.length, 1);
		assert.deepEqual(contexts[0], {
			event: {
				environment: 'test',
				guildId: 'guild-1',
				level: 'error',
				logs: [
					{
						data: { step: 'boot' },
						level: 'trace',
						levelValue: 10,
						time: new Date('2026-05-29T10:00:00.010Z'),
					},
				],
				message: 'ready',
				ready: true,
				service: 'slipher-bot',
				shardId: 1,
				timestamp: '2026-05-29T10:00:00.000Z',
				version: '1.2.3',
			},
		});
		assert.equal(flushes, 1);
	});

	test('createEvlogDrainAdapter can use evlog fields from bindings', async () => {
		const contexts: unknown[] = [];
		const adapter = createEvlogDrainAdapter(context => contexts.push(context));

		await adapter.write({
			bindings: { environment: 'production', service: 'discord-worker' },
			data: {},
			level: 'trace',
			levelValue: 10,
			logs: [],
			time: new Date('2026-05-29T10:00:00.000Z'),
		});

		assert.deepEqual(contexts[0], {
			event: {
				environment: 'production',
				level: 'debug',
				logs: [],
				service: 'discord-worker',
				timestamp: '2026-05-29T10:00:00.000Z',
			},
		});
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

	test('extracts useful Seyfert context from interactions and contexts', () => {
		assert.deepEqual(
			extractSeyfertLogContext({
				fullCommandName: 'image anime',
				guildId: 'guild-1',
				channelId: 'channel-1',
				shardId: 2,
				author: { id: 'user-1', username: 'Socram' },
				interaction: { id: 'interaction-1', locale: 'es-ES' },
			}),
			{
				channelId: 'channel-1',
				command: 'image anime',
				guildId: 'guild-1',
				interactionId: 'interaction-1',
				locale: 'es-ES',
				shardId: 2,
				userId: 'user-1',
				username: 'Socram',
			},
		);
	});
});

function clock(values: Date[]): () => Date {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)];
}
