import { assert, describe, test } from 'vitest';
import { ConsoleLoggerAdapter, createLogger, type LogEntry, type LoggerAdapter, redactLogValue } from '../src';

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
