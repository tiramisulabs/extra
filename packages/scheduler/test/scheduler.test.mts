import { assert, describe, test } from 'vitest';
import { CronExpression, parseCronField, parseDuration, Scheduler } from '../src';

function waitForEvent<TArgs extends readonly unknown[]>(
	scheduler: { on(event: string, listener: (...args: TArgs) => void): () => void },
	event: string,
): Promise<TArgs> {
	return new Promise(resolve => {
		const off = scheduler.on(event, (...args: TArgs) => {
			off();
			resolve(args);
		});
	});
}

describe('parseDuration', () => {
	test('parses scheduler intervals', () => {
		assert.equal(parseDuration('10ms'), 10);
		assert.equal(parseDuration('1s 5ms'), 1005);
		assert.equal(parseDuration('2m'), 120_000);
		assert.throws(() => parseDuration('0ms'), RangeError);
	});
});

describe('CronExpression', () => {
	test('parses fields and matches dates', () => {
		const expression = new CronExpression('*/15 9-17 * * 1-5');
		const mondayMorning = new Date('2026-05-25T09:15:00Z');
		const sundayMorning = new Date('2026-05-24T09:15:00Z');

		assert.equal(expression.matches(mondayMorning), true);
		assert.equal(expression.matches(sundayMorning), false);
	});

	test('computes the next matching date', () => {
		const expression = new CronExpression('30 8 * * *');
		const next = expression.next(new Date('2026-05-29T08:29:20Z'));

		assert.equal(next.toISOString(), '2026-05-29T08:30:00.000Z');
	});

	test('accepts Sunday as 7', () => {
		assert.deepEqual([...parseCronField('0,7', 0, 7, value => (value === 7 ? 0 : value))], [0]);
	});
});

describe('Scheduler', () => {
	test('runs interval tasks and reschedules them', async () => {
		const scheduler = new Scheduler();
		const completed = waitForEvent(scheduler, 'completed');

		const task = scheduler.every('5ms', () => 'ok', { id: 'cleanup' });
		const [completedTask] = await completed;

		assert.equal(completedTask, task);
		assert.equal(task.id, 'cleanup');
		assert.equal(task.runCount, 1);
		assert.ok(task.lastRunAt instanceof Date);
		assert.ok(task.nextRunAt instanceof Date);
		scheduler.clear();
	});

	test('can run a task immediately', async () => {
		const scheduler = new Scheduler();
		const started = waitForEvent(scheduler, 'started');

		const task = scheduler.every('1h', () => undefined, { runImmediately: true });
		const [startedTask] = await started;

		assert.equal(startedTask, task);
		assert.equal(task.runCount, 1);
		scheduler.clear();
	});

	test('emits failures and keeps task errors', async () => {
		const scheduler = new Scheduler();
		const failed = waitForEvent(scheduler, 'failed');
		const error = new Error('boom');

		const task = scheduler.every('5ms', () => {
			throw error;
		});
		const [failedTask, failedError] = await failed;

		assert.equal(failedTask, task);
		assert.equal(failedError, error);
		assert.equal(task.lastError, error);
		scheduler.clear();
	});

	test('can pause, start, remove, and list tasks', () => {
		const scheduler = new Scheduler({ autostart: false });
		const task = scheduler.every('1m', () => undefined, { id: 'report' });

		assert.deepEqual(scheduler.list(), [task]);
		scheduler.start('report');
		assert.equal(task.status, 'scheduled');
		scheduler.pause('report');
		assert.equal(task.status, 'paused');
		assert.equal(scheduler.remove('report'), true);
		assert.equal(scheduler.get('report'), undefined);
	});

	test('creates cron tasks without starting when autostart is disabled', () => {
		const scheduler = new Scheduler({ autostart: false });
		const task = scheduler.cron('* * * * *', () => undefined, { id: 'cron' });

		assert.equal(task.kind, 'cron');
		assert.equal(task.nextRunAt, undefined);
		assert.equal(scheduler.get('cron'), task);
	});
});
