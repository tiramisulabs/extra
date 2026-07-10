import { createRequire } from 'node:module';
import type { BackoffOptions, BullMQModuleLike, JobOptions, QueueOptions, RetryDelayResolver } from './core';

export type DurationInput = number | string;

export const queueAddAmbiguityMessage = [
	'Ambiguous queue.add() call: a string first argument plus an options-shaped second argument can be either data/options or name/data.',
	'Use add(name, data, options) for named jobs, or pass non-string data to add(data, options).',
].join(' ');

const queueJobOptionKeys = new Set(['id', 'delay', 'attempts', 'priority', 'retryDelay']);
const durationUnits = new Map<string, number>([
	['ms', 1],
	['millisecond', 1],
	['milliseconds', 1],
	['s', 1000],
	['sec', 1000],
	['second', 1000],
	['seconds', 1000],
	['m', 60_000],
	['min', 60_000],
	['minute', 60_000],
	['minutes', 60_000],
	['h', 3_600_000],
	['hr', 3_600_000],
	['hour', 3_600_000],
	['hours', 3_600_000],
	['d', 86_400_000],
	['day', 86_400_000],
	['days', 86_400_000],
]);

export class InvalidDurationError extends RangeError {
	constructor(input: DurationInput) {
		super(`Invalid duration: ${String(input)}`);
		this.name = 'InvalidDurationError';
	}
}

export function parseDuration(input: DurationInput): number {
	if (typeof input === 'number') {
		if (Number.isFinite(input) && input >= 0) return input;
		throw new InvalidDurationError(input);
	}

	const source = input.trim().toLowerCase();
	if (!source) throw new InvalidDurationError(input);

	const numeric = Number(source);
	if (Number.isFinite(numeric) && numeric >= 0) return numeric;

	let total = 0;
	let consumed = 0;
	const matcher = /\s*(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|sec|s|minutes?|min|m|hours?|hr|h|days?|d)\s*/gy;
	for (let match = matcher.exec(source); match; match = matcher.exec(source)) {
		consumed += match[0].length;
		total += Number(match[1]) * durationUnits.get(match[2]!)!;
	}

	if (consumed !== source.length || total < 0) throw new InvalidDurationError(input);
	return total;
}

function isAmbiguousQueueAddArgs(nameOrPayload: unknown, payloadOrOptions: unknown, maybeOptions: unknown): boolean {
	return (
		typeof nameOrPayload === 'string' &&
		payloadOrOptions !== undefined &&
		maybeOptions === undefined &&
		isJobOptionsLike(payloadOrOptions)
	);
}

function isJobOptionsLike(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every(key => queueJobOptionKeys.has(key));
}

export function createJobIdGenerator() {
	let nextId = 0;
	return () => String(++nextId);
}

export function loadBullMQ(): BullMQModuleLike {
	try {
		const require = createRequire(__filename);
		return require('bullmq') as BullMQModuleLike;
	} catch (error) {
		throw new Error(
			'The persistent() queue driver requires bullmq. Install bullmq or pass a structural bullmq module.',
			{
				cause: error,
			},
		);
	}
}

export function parseQueueAddArgs<TData, TResult>(
	nameOrData: unknown,
	dataOrOptions?: unknown,
	maybeOptions?: JobOptions<TData, TResult>,
): { data: TData; name: string; options: JobOptions<TData, TResult> } {
	if (isAmbiguousQueueAddArgs(nameOrData, dataOrOptions, maybeOptions)) {
		throw new TypeError(queueAddAmbiguityMessage);
	}

	if (typeof nameOrData === 'string' && dataOrOptions !== undefined) {
		return {
			data: dataOrOptions as TData,
			name: nameOrData,
			options: maybeOptions ?? {},
		};
	}

	return {
		data: nameOrData as TData,
		name: 'default',
		options: (dataOrOptions ?? {}) as JobOptions<TData, TResult>,
	};
}

export function resolveRetryDelayValue(
	value: Exclude<RetryDelayResolver<unknown, unknown>, Function>,
	attemptsMade: number,
): number {
	if (typeof value !== 'object') return parseDuration(value);
	const backoff = normalizeBackoffOptions(value);
	const delay = parseDuration(backoff.delay ?? 0);
	if (backoff.type === 'exponential') return delay * 2 ** Math.max(attemptsMade - 1, 0);
	return delay;
}

export function normalizeBullJobState(
	state: string | undefined,
): 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | undefined {
	switch (state) {
		case 'waiting':
		case 'prioritized':
		case 'waiting-children':
		case 'paused':
			return 'waiting';
		case 'delayed':
		case 'active':
		case 'completed':
		case 'failed':
			return state;
		default:
			return undefined;
	}
}

export function normalizeBackoffOptions(value: BackoffOptions): BackoffOptions {
	return {
		...value,
		delay: value.delay === undefined ? undefined : parseDuration(value.delay),
	};
}

export function warnRetryDelayWithoutRetries<TData, TResult>(
	retryDelay: RetryDelayResolver<TData, TResult> | undefined,
	attempts: number,
	scope: string,
): void {
	if (retryDelay === undefined || attempts > 1) return;
	process.emitWarning?.(`${scope} defines retryDelay but attempts is ${attempts}; no retries will be scheduled.`, {
		code: 'SLIPHER_QUEUE_RETRY_DELAY_NO_RETRIES',
	});
}

export function eventRecord(event: unknown): Record<string, unknown> {
	return event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
}

export function sameQueueOptions<TData, TResult>(
	left: QueueOptions<never, never>,
	right: QueueOptions<TData, TResult>,
): boolean {
	return (
		left.concurrency === right.concurrency &&
		left.attempts === right.attempts &&
		left.autostart === right.autostart &&
		left.retention === right.retention &&
		left.now === right.now &&
		left.idGenerator === right.idGenerator &&
		left.reportListenerError === right.reportListenerError &&
		sameRetryDelay(left.retryDelay, right.retryDelay)
	);
}

export function sameRetryDelay(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
	return JSON.stringify(left) === JSON.stringify(right);
}

export function isClientInitialized(client: object): boolean {
	return !('initialized' in client) || client.initialized !== false;
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key] === undefined) delete value[key];
	}
	return value;
}
