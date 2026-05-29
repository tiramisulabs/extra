import { assert, describe, test } from 'vitest';
import {
	ConsoleLoggerAdapter,
	commandLogger,
	createLogger,
	createSeyfertLogger,
	createSeyfertLoggerDefaults,
	createSeyfertLoggerServices,
	extractSeyfertLogContext,
	installSeyfertLogger,
	installSeyfertLoggerDefaults,
	type LogEntry,
	type LoggerAdapter,
	redactLogValue,
	type SeyfertClientLike,
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

describe('createLogger', () => {
	test('filters entries below the configured level', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, level: 'warn' });

		await logger.debug({ hidden: true }, 'debug message');
		await logger.info('info message');
		await logger.warn({ visible: true }, 'warn message');

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].level, 'warn');
		assert.equal(adapter.entries[0].message, 'warn message');
		assert.deepEqual(adapter.entries[0].data, { visible: true });
	});

	test('writes normalized entries at or above the configured level', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, name: 'worker', level: 'debug' });

		await logger.error({ guildId: '123' }, 'sync failed');

		assert.equal(adapter.entries.length, 1);
		assert.equal(adapter.entries[0].name, 'worker');
		assert.equal(adapter.entries[0].level, 'error');
		assert.equal(adapter.entries[0].levelValue, 50);
		assert.equal(adapter.entries[0].message, 'sync failed');
		assert.deepEqual(adapter.entries[0].bindings, {});
		assert.deepEqual(adapter.entries[0].data, { guildId: '123' });
		assert.instanceOf(adapter.entries[0].time, Date);
	});

	test('accepts Seyfert core logger variadic calls', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, level: 'debug' });
		const error = new Error('boom');

		await logger.warn('EventHandler.onFail', error, 'MESSAGE_CREATE');

		assert.equal(adapter.entries[0].message, 'EventHandler.onFail');
		assert.equal((adapter.entries[0].data.error as { message: string }).message, 'boom');
		assert.deepEqual(adapter.entries[0].data.args, ['MESSAGE_CREATE']);
	});

	test('does not mutate caller log objects when appending extra args', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter });
		const payload: Record<string, unknown> = { guildId: '123' };
		const error = new Error('boom');

		await logger.error(payload, 'failed', error);

		assert.deepEqual(payload, { guildId: '123' });
		assert.equal((adapter.entries[0].data.error as { message: string }).message, 'boom');
	});

	test('child loggers merge bindings into every entry', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, name: 'api' }).child({ shardId: 1 }).child({ guildId: '123' });

		await logger.info({ route: '/sync' }, 'started');

		assert.deepEqual(adapter.entries[0].bindings, { shardId: 1, guildId: '123' });
		assert.deepEqual(adapter.entries[0].data, { route: '/sync' });
	});

	test('redacts matching fields recursively before writing', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, redact: ['token', 'authorization'] });

		await logger.info(
			{
				token: 'secret',
				nested: {
					authorization: 'Bearer secret',
					keep: true,
				},
				items: [{ token: 'other-secret' }],
			},
			'redacted',
		);

		assert.deepEqual(adapter.entries[0].data, {
			token: '[Redacted]',
			nested: {
				authorization: '[Redacted]',
				keep: true,
			},
			items: [{ token: '[Redacted]' }],
		});
	});

	test('redacts circular structures without throwing', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, redact: ['token'] });
		const payload: Record<string, unknown> = { token: 'secret' };
		payload.self = payload;

		await logger.info(payload, 'redacted circular');

		assert.deepEqual(adapter.entries[0].data, {
			token: '[Redacted]',
			self: '[Circular]',
		});
	});

	test('redactLogValue can be used directly', () => {
		assert.deepEqual(redactLogValue({ accessToken: 'secret', ok: true }, ['accessToken']), {
			accessToken: '[Redacted]',
			ok: true,
		});
	});

	test('flush proxies to the adapter when available', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter });

		await logger.flush();

		assert.equal(adapter.flushes, 1);
	});

	test('silent level suppresses every entry', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, level: 'silent' });

		await logger.fatal('fatal message');

		assert.equal(adapter.entries.length, 0);
	});
});

describe('ConsoleLoggerAdapter', () => {
	test('implements the logger adapter contract', () => {
		const adapter: LoggerAdapter = new ConsoleLoggerAdapter();

		assert.equal(typeof adapter.write, 'function');
	});
});

describe('Seyfert logger integration', () => {
	test('installs the logger as the client and handler logger', () => {
		const logger = createLogger({ adapter: new RecordingAdapter() });
		const client = {
			logger: undefined,
			commands: { logger: undefined },
			components: { logger: undefined },
			events: { logger: undefined },
			langs: { logger: undefined },
			cache: { __logger__: undefined },
		};

		const installed = installSeyfertLogger(client, logger);

		assert.equal(installed, logger);
		assert.equal(client.logger, logger);
		assert.equal(client.commands.logger, logger);
		assert.equal(client.components.logger, logger);
		assert.equal(client.events.logger, logger);
		assert.equal(client.langs.logger, logger);
		assert.equal(client.cache.__logger__, logger);
	});

	test('can replace Seyfert defaults when installed on a client', async () => {
		const adapter = new RecordingAdapter();
		const client: SeyfertClientLike = {
			logger: undefined,
			options: {
				commands: { defaults: { custom: true } },
			},
		};

		const logger = createSeyfertLogger({ adapter, client, defaults: true, level: 'debug' });
		const commandDefaults = client.options?.commands?.defaults as Record<string, unknown>;
		const componentDefaults = client.options?.components?.defaults as Record<string, unknown>;
		const modalDefaults = client.options?.modals?.defaults as Record<string, unknown>;
		const onBeforeMiddlewares = commandDefaults.onBeforeMiddlewares as (context: unknown) => unknown;

		await onBeforeMiddlewares({ fullCommandName: 'ping', author: { id: 'user-1' } });

		assert.equal(client.logger, logger);
		assert.equal(commandDefaults.custom, true);
		assert.equal(typeof commandDefaults.onRunError, 'function');
		assert.equal(typeof componentDefaults.onRunError, 'function');
		assert.equal(typeof modalDefaults.onRunError, 'function');
		assert.equal(adapter.entries[0].level, 'debug');
		assert.equal(adapter.entries[0].message, 'command received');
		assert.equal(adapter.entries[0].data.command, 'ping');
	});

	test('installs explicit Seyfert defaults without replacing the logger', () => {
		const logger = createLogger({ adapter: new RecordingAdapter() });
		const defaults = createSeyfertLoggerDefaults(logger);
		const client: SeyfertClientLike = { options: {} };

		const installed = installSeyfertLoggerDefaults(client, defaults);

		assert.equal(installed, client);
		assert.equal(client.options.commands?.defaults?.onRunError, defaults.commands.onRunError);
		assert.equal(client.options.components?.defaults?.onAfterRun, defaults.components.onAfterRun);
		assert.equal(client.options.modals?.defaults?.onBeforeMiddlewares, defaults.modals.onBeforeMiddlewares);
	});

	test('extracts useful Seyfert context fields', () => {
		const context = {
			fullCommandName: 'image anime',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 2,
			author: { id: 'user-1', username: 'Socram' },
			interaction: { id: 'interaction-1', locale: 'es-ES' },
		};

		assert.deepEqual(extractSeyfertLogContext(context), {
			command: 'image anime',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 2,
			userId: 'user-1',
			username: 'Socram',
			interactionId: 'interaction-1',
			locale: 'es-ES',
		});
	});

	test('provides a global command logging middleware', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter });
		const middleware = commandLogger(logger);
		let nextCalled = false;

		await middleware({
			context: {
				fullCommandName: 'ping',
				guildId: 'guild-1',
				channelId: 'channel-1',
				shardId: 0,
				author: { id: 'user-1' },
				interaction: { id: 'interaction-1' },
			},
			next: () => {
				nextCalled = true;
			},
			stop: () => undefined,
			pass: () => undefined,
		});

		assert.equal(nextCalled, true);
		assert.equal(adapter.entries[0].message, 'command executed');
		assert.deepEqual(adapter.entries[0].data, {
			command: 'ping',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 0,
			userId: 'user-1',
			interactionId: 'interaction-1',
		});
	});

	test('creates Seyfert services for setServices middleware registration', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter });
		const services = createSeyfertLoggerServices(logger, {
			commandMiddlewareName: 'slipherLogger',
			commandMiddleware: { message: 'command observed' },
		});
		let nextCalled = false;

		await services.middlewares.slipherLogger({
			context: {
				fullCommandName: 'ping',
				author: { id: 'user-1' },
				interaction: { id: 'interaction-1' },
			},
			next: () => {
				nextCalled = true;
			},
			stop: () => undefined,
			pass: () => undefined,
		});

		assert.equal(nextCalled, true);
		assert.equal(adapter.entries[0].message, 'command observed');
		assert.equal(adapter.entries[0].data.command, 'ping');
	});

	test('provides Seyfert defaults that log command errors with context', async () => {
		const adapter = new RecordingAdapter();
		const logger = createLogger({ adapter, level: 'debug' });
		const defaults = createSeyfertLoggerDefaults(logger);
		const error = new Error('failed');
		const context = {
			fullCommandName: 'image anime',
			guildId: 'guild-1',
			channelId: 'channel-1',
			shardId: 1,
			author: { id: 'user-1' },
			interaction: { id: 'interaction-1' },
		};

		await defaults.commands.onBeforeMiddlewares(context);
		await defaults.commands.onRunError(context, error);
		await defaults.commands.onAfterRun(context, undefined);

		assert.equal(adapter.entries[0].level, 'debug');
		assert.equal(adapter.entries[0].message, 'command received');
		assert.equal(adapter.entries[1].level, 'error');
		assert.equal(adapter.entries[1].message, 'command failed');
		assert.equal((adapter.entries[1].data.error as { message: string }).message, 'failed');
		assert.equal(adapter.entries[1].data.command, 'image anime');
		assert.equal(adapter.entries[2].level, 'info');
		assert.equal(adapter.entries[2].message, 'command completed');
	});
});
