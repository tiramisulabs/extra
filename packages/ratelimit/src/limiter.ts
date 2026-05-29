import { type DurationInput, parseDuration } from './duration';
import { type Awaitable, MemoryRateLimitStore, type RateLimitStore } from './store';

export type RateLimitKey = string | number | bigint | readonly RateLimitKey[];
export type RateLimitResolver<TContext, TValue> = TValue | ((context: TContext) => Awaitable<TValue>);
export type RateLimitKeyResolver<TContext> = (context: TContext) => Awaitable<RateLimitKey>;

export interface RateLimiterOptions<TContext = unknown> {
	name?: string;
	limit: RateLimitResolver<TContext, number>;
	window: RateLimitResolver<TContext, DurationInput>;
	key: RateLimitKeyResolver<TContext>;
	store?: RateLimitStore;
	prefix?: string;
	now?: () => number;
}

export interface RateLimitConsumeOptions<TContext = unknown> {
	cost?: number;
	key?: RateLimitKey | RateLimitKeyResolver<TContext>;
	limit?: RateLimitResolver<TContext, number>;
	window?: RateLimitResolver<TContext, DurationInput>;
}

export interface RateLimitResult {
	allowed: boolean;
	key: string;
	limit: number;
	remaining: number;
	used: number;
	resetAt: Date;
	retryAfter: number;
	retryAfterSeconds: number;
}

export class RateLimiter<TContext = unknown> {
	readonly name?: string;
	readonly store: RateLimitStore;
	readonly prefix: string;
	private readonly getLimit: RateLimitResolver<TContext, number>;
	private readonly getWindow: RateLimitResolver<TContext, DurationInput>;
	private readonly getKey: RateLimitKeyResolver<TContext>;
	private readonly now: () => number;

	constructor(options: RateLimiterOptions<TContext>) {
		this.name = options.name;
		this.store = options.store ?? new MemoryRateLimitStore();
		this.prefix = options.prefix ?? 'ratelimit';
		this.getLimit = options.limit;
		this.getWindow = options.window;
		this.getKey = options.key;
		this.now = options.now ?? Date.now;
	}

	async consume(context: TContext, options: RateLimitConsumeOptions<TContext> = {}): Promise<RateLimitResult> {
		const resolved = await this.resolve(context, options);
		const state = await this.store.consume(resolved.key, {
			limit: resolved.limit,
			window: resolved.window,
			cost: resolved.cost,
			now: resolved.now,
		});

		return this.toResult(resolved.key, state);
	}

	async peek(
		context: TContext,
		options: Omit<RateLimitConsumeOptions<TContext>, 'cost'> = {},
	): Promise<RateLimitResult> {
		const resolved = await this.resolve(context, options);
		const state = await this.store.peek(resolved.key, {
			limit: resolved.limit,
			window: resolved.window,
			now: resolved.now,
		});

		return this.toResult(resolved.key, state);
	}

	async reset(context: TContext, key?: RateLimitKey | RateLimitKeyResolver<TContext>): Promise<boolean> {
		return this.store.reset(await this.resolveKey(context, key ?? this.getKey));
	}

	async blockUntilAllowed(
		context: TContext,
		options: RateLimitConsumeOptions<TContext> = {},
	): Promise<RateLimitResult> {
		let result = await this.consume(context, options);

		while (!result.allowed) {
			await new Promise(resolve => setTimeout(resolve, result.retryAfter));
			result = await this.consume(context, options);
		}

		return result;
	}

	private async resolve(context: TContext, options: RateLimitConsumeOptions<TContext>) {
		const now = this.now();
		const [key, limit, window] = await Promise.all([
			this.resolveKey(context, options.key ?? this.getKey),
			this.resolveValue(context, options.limit ?? this.getLimit),
			this.resolveValue(context, options.window ?? this.getWindow),
		]);
		const cost = options.cost ?? 1;

		if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('Rate limit must be a positive integer.');
		if (!Number.isInteger(cost) || cost <= 0) throw new RangeError('Rate limit cost must be a positive integer.');

		return {
			cost,
			key,
			limit,
			now,
			window: parseDuration(window),
		};
	}

	private async resolveKey(context: TContext, key: RateLimitKey | RateLimitKeyResolver<TContext>): Promise<string> {
		const resolved = typeof key === 'function' ? await key(context) : key;
		const serialized = serializeRateLimitKey(resolved);
		const parts = [this.prefix, this.name, serialized].filter((part): part is string => Boolean(part));

		return parts.join(':');
	}

	private async resolveValue<TValue>(context: TContext, value: RateLimitResolver<TContext, TValue>): Promise<TValue> {
		return typeof value === 'function' ? (value as (context: TContext) => Awaitable<TValue>)(context) : value;
	}

	private toResult(key: string, state: Awaited<ReturnType<RateLimitStore['consume']>>): RateLimitResult {
		return {
			allowed: state.allowed,
			key,
			limit: state.limit,
			remaining: state.remaining,
			resetAt: new Date(state.resetAt),
			retryAfter: state.retryAfter,
			retryAfterSeconds: Math.ceil(state.retryAfter / 1000),
			used: state.count,
		};
	}
}

export function serializeRateLimitKey(key: RateLimitKey): string {
	if (Array.isArray(key)) return key.map(serializeRateLimitKey).join(':');
	return String(key);
}
