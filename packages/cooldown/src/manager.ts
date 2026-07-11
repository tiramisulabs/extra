import { type AnyContext, CacheFrom, type CommandFromContent, type ReturnCache, type UsingClient } from 'seyfert';
import type { BaseClient } from 'seyfert/lib/client/base';
import { type Awaitable, fakePromise } from 'seyfert/lib/common';
import { getCooldownContext } from './context';
import { COOLDOWN_RESOURCE_FIELD_PREFIX, COOLDOWN_RESOURCE_RELATIONSHIP_SUFFIX, CooldownResource } from './resource';

export type CooldownTargetType = 'user' | 'guild' | 'channel' | 'global';
export type CooldownTargetResolver = (context: AnyContext) => string | undefined;

export interface CooldownProps {
	/**
	 * Cooldown target. `guild` and `channel` fall back to `author.id` in DMs
	 * because Discord does not provide `guildId`/`channelId` for every context.
	 */
	type?: CooldownTargetType | CooldownTargetResolver;
	/** Interval in ms before the bucket refills. */
	interval: number;
	/** Available uses in the bucket. Defaults to 1. */
	uses?: number;
	/** Shared bucket name. When set, the cache key uses this name instead of the resolved command. */
	group?: string;
}

interface CooldownResultBase {
	/** Maximum uses for the bucket. */
	limit: number;
	/** Uses still available after the operation. */
	remainingUses: number;
	/** Cache key used by this operation, useful for logging and metrics. */
	key: string;
}

export type CooldownResult =
	| (CooldownResultBase & {
			allowed: true;
			remainingMs: 0;
			retryAfter: Date;
	  })
	| (CooldownResultBase & {
			allowed: false;
			remainingMs: number;
			retryAfter: Date;
	  });

export interface CooldownImplicitOptions {
	cost?: number;
}

export interface CooldownCheckOptions extends CooldownImplicitOptions {
	name: string;
	target: string;
	guildId?: string;
}

export type CooldownConsumeOptions = CooldownCheckOptions;

export interface CooldownResetOptions {
	name: string;
	target: string;
	guildId?: string;
}

interface ResolvedBucket {
	props: CooldownProps;
	key: string;
}

type AtomicCooldownResult = [
	allowed: number,
	remainingMs: number,
	retryAfterMs: number,
	limit: number,
	remainingUses: number,
];

export interface AtomicCooldownAdapter {
	supportsAtomicCooldowns: true;
	eval<T = unknown>(script: string, keys: string[], args: string[]): Awaitable<T>;
}

interface CooldownCommandLike {
	cooldown?: CooldownProps;
	guildId?: string[];
	name?: string;
}

interface CooldownContextLike {
	author?: { id?: string };
	channelId?: string;
	command?: CooldownCommandLike;
	fullCommandName?: string;
	guildId?: string;
}

const ATOMIC_CONSUME_SCRIPT = `
local hashKey = KEYS[1]
local namespaceKey = KEYS[2]
local interval = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local memberKey = ARGV[4]

local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local remaining = tonumber(redis.call('HGET', hashKey, '${COOLDOWN_RESOURCE_FIELD_PREFIX}remaining'))
local lastDrip = tonumber(redis.call('HGET', hashKey, '${COOLDOWN_RESOURCE_FIELD_PREFIX}lastDrip'))
local maxSafeInteger = 9007199254740991
local invalidRemaining = remaining == nil or remaining % 1 ~= 0 or remaining < 0 or remaining > limit or math.abs(remaining) > maxSafeInteger
local invalidLastDrip = lastDrip == nil or lastDrip % 1 ~= 0 or lastDrip > now or math.abs(lastDrip) > maxSafeInteger

if invalidRemaining or invalidLastDrip or now - lastDrip >= interval then
	local newRemaining = limit - cost
	redis.call('SADD', namespaceKey .. '${COOLDOWN_RESOURCE_RELATIONSHIP_SUFFIX}', memberKey)
	redis.call('HSET', hashKey, '${COOLDOWN_RESOURCE_FIELD_PREFIX}interval', tostring(interval), '${COOLDOWN_RESOURCE_FIELD_PREFIX}remaining', tostring(newRemaining), '${COOLDOWN_RESOURCE_FIELD_PREFIX}lastDrip', tostring(now))
	return {1, 0, now, limit, newRemaining}
end

local elapsed = now - lastDrip
local newRemaining = remaining - cost
if newRemaining < 0 then
	local remainingMs = interval - elapsed
	return {0, remainingMs, now + remainingMs, limit, remaining}
end

redis.call('SADD', namespaceKey .. '${COOLDOWN_RESOURCE_RELATIONSHIP_SUFFIX}', memberKey)
redis.call('HSET', hashKey, '${COOLDOWN_RESOURCE_FIELD_PREFIX}interval', tostring(interval), '${COOLDOWN_RESOURCE_FIELD_PREFIX}remaining', tostring(newRemaining))
return {1, 0, now, limit, newRemaining}
`;

export class CooldownManager {
	private _client?: BaseClient;
	private _resource?: CooldownResource;
	private readonly pendingMutations = new Map<string, Promise<void>>();

	constructor(client?: BaseClient) {
		if (client) this.attach(client);
	}

	/** @internal */
	attach(client: BaseClient): this {
		if (this._client === client) return this;
		if (this._client) throw new Error('CooldownManager is already attached to another client.');
		this._client = client;
		this._resource = new CooldownResource(client.cache, client as unknown as UsingClient);
		return this;
	}

	get client(): BaseClient {
		if (!this._client)
			throw new Error(
				'CooldownManager is not attached to a client. Use the cooldown() plugin or pass a client to the constructor.',
			);
		return this._client;
	}

	/** @internal */
	get resource(): CooldownResource {
		if (!this._resource)
			throw new Error(
				'CooldownManager is not attached to a client. Use the cooldown() plugin or pass a client to the constructor.',
			);
		return this._resource;
	}

	private get debugger() {
		return this.client.debugger;
	}

	private getFullCommandName({ command, parent, fullCommandName }: CommandFromContent) {
		if (!command) return fullCommandName;
		if (parent && command !== parent)
			return [parent.name, 'group' in command ? command.group : undefined, command.name].filter(Boolean).join(' ');
		return command.name || fullCommandName;
	}

	private getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
		this.debugger?.info(`Resolving cooldown data for command ${name} with guildId ${guildId}`);

		const resolved = this.client.handleCommand.resolveByName(name, guildId);
		if (!resolved?.command) return undefined;
		const { command, parent, fullCommandName } = resolved;

		const resolvedName = this.getFullCommandName({ command, parent, fullCommandName });
		const cooldown = command.cooldown ?? parent?.cooldown;

		this.debugger?.info(`Found command ${command.name} for cooldown data resolution`);
		if (guildId) {
			this.debugger?.info(`Checking guild-specific cooldown for command ${command.name} and guildId ${guildId}`);
			const commandExcludesGuild = command.guildId && !command.guildId.includes(guildId);
			const parentExcludesGuild = parent?.guildId && !parent.guildId.includes(guildId);

			if (commandExcludesGuild || parentExcludesGuild) {
				this.debugger?.info(`No guild-specific cooldown found for command ${command.name} and guildId ${guildId}`);
				return undefined;
			}

			return [resolvedName, cooldown];
		}

		this.debugger?.info(`No guildId provided, checking for global cooldown for command ${command.name}`);
		return [resolvedName, cooldown];
	}

	private buildKey(props: CooldownProps, resolvedName: string, target: string): string {
		const namespace = props.group ?? resolvedName;
		if (!namespace.trim()) throw new RangeError('Cooldown group and command names must not be empty.');
		const encodedNamespace = encodeURIComponent(namespace);
		if (props.type === 'global') return `${encodedNamespace}:global:global`;
		if (!target.trim()) throw new RangeError('Cooldown targets must not be empty.');
		const typeLabel = typeof props.type === 'function' ? 'custom' : (props.type ?? 'user');
		return `${encodedNamespace}:${typeLabel}:${encodeURIComponent(target)}`;
	}

	private resolveExplicitBucket(options: CooldownCheckOptions): ResolvedBucket | undefined {
		const [resolvedName, props] = this.getCommandData(options.name, options.guildId) ?? [];
		if (!(resolvedName && props)) return undefined;
		return { props, key: this.buildKey(props, resolvedName, options.target) };
	}

	private resolveScopedBucket(): ResolvedBucket | undefined {
		const context = this.getCooldownContext();
		const { command, fullCommandName } = context;
		if (!(command && fullCommandName)) return undefined;

		let props = command.cooldown;
		let resolvedName = fullCommandName;

		if (!props) {
			const resolved = this.getCommandData(fullCommandName, context.guildId);
			if (!resolved) return undefined;
			[resolvedName, props] = resolved;
		}

		if (!props) return undefined;
		const target = this.resolveContextTarget(context, props);
		if (target === undefined) return undefined;

		this.debugger?.info(`Using target ${target} for cooldown of command ${resolvedName}`);
		return { props, key: this.buildKey(props, resolvedName, target) };
	}

	private resolveBucket(
		options: CooldownCheckOptions | CooldownImplicitOptions | undefined,
	): ResolvedBucket | undefined {
		if (isExplicitOptions(options)) return this.resolveExplicitBucket(options);
		return this.resolveScopedBucket();
	}

	private getCooldownContext(): CooldownContextLike {
		const context = getCooldownContext() as CooldownContextLike | undefined;
		if (!context) {
			throw new Error(
				'Cannot resolve an implicit cooldown outside of a Seyfert cooldown scope. Use the explicit form, for example client.cooldown.consume({ name, target, guildId }).',
			);
		}

		return context;
	}

	private resolveLimit(props: CooldownProps) {
		const limit = props.uses ?? 1;
		if (!(Number.isSafeInteger(limit) && limit > 0)) {
			throw new RangeError('Cooldown uses must be a positive safe integer.');
		}
		return limit;
	}

	private resolveInterval(props: CooldownProps): number {
		if (!(Number.isFinite(props.interval) && props.interval > 0)) {
			throw new RangeError('Cooldown interval must be a positive finite number.');
		}
		return props.interval;
	}

	private assertCostWithinLimit(cost: number, limit: number) {
		if (!(Number.isSafeInteger(cost) && cost > 0)) {
			throw new RangeError('Cooldown cost must be a positive safe integer.');
		}
		if (cost > limit) throw new RangeError(`Cooldown cost (${cost}) cannot exceed the bucket limit (${limit}).`);
	}

	private mutate<T>(key: string, operation: () => Awaitable<T>): ReturnCache<T> {
		const pending = this.pendingMutations.get(key);
		if (pending) return fakePromise(this.enqueueMutation(key, pending, operation)) as ReturnCache<T>;

		const result = operation();
		if (!isPromiseLike(result)) return result as ReturnCache<T>;
		return fakePromise(this.trackMutation(key, result as PromiseLike<T>)) as ReturnCache<T>;
	}

	private enqueueMutation<T>(key: string, pending: Promise<void>, operation: () => Awaitable<T>): Promise<T> {
		return this.trackMutation(key, pending.then(operation));
	}

	private trackMutation<T>(key: string, result: PromiseLike<T>): Promise<T> {
		const promise = Promise.resolve(result);
		const settled = promise.then(
			() => undefined,
			() => undefined,
		);
		this.pendingMutations.set(key, settled);
		return promise.finally(() => {
			if (this.pendingMutations.get(key) === settled) this.pendingMutations.delete(key);
		});
	}

	private rateLimitedResult(
		key: string,
		limit: number,
		remainingUses: number,
		now: number,
		remainingMs: number,
	): CooldownResult {
		return {
			allowed: false,
			remainingMs,
			retryAfter: new Date(now + remainingMs),
			limit,
			remainingUses,
			key,
		};
	}

	private allowedResult(key: string, limit: number, remainingUses: number, now: number): CooldownResult {
		return {
			allowed: true,
			remainingMs: 0,
			retryAfter: new Date(now),
			limit,
			remainingUses,
			key,
		};
	}

	private getAtomicAdapter(): AtomicCooldownAdapter | undefined {
		const adapter = this.resource.adapter as Partial<AtomicCooldownAdapter>;
		return adapter.supportsAtomicCooldowns === true && typeof adapter.eval === 'function'
			? (adapter as AtomicCooldownAdapter)
			: undefined;
	}

	private consumeAtomic(
		adapter: AtomicCooldownAdapter,
		key: string,
		props: CooldownProps,
		limit: number,
		cost: number,
	): ReturnCache<CooldownResult> {
		return fakePromise(
			adapter.eval<AtomicCooldownResult>(
				ATOMIC_CONSUME_SCRIPT,
				[this.resource.hashId(key), this.resource.namespace],
				[String(props.interval), String(limit), String(cost), key],
			),
		).then(result => this.fromAtomicResult(key, result));
	}

	private fromAtomicResult(key: string, result: AtomicCooldownResult): CooldownResult {
		const allowedValue = Number(result[0]);
		const remainingMs = Number(result[1]);
		const retryAfterMs = Number(result[2]);
		const limit = Number(result[3]);
		const remainingUses = Number(result[4]);
		if (
			!(allowedValue === 0 || allowedValue === 1) ||
			!(Number.isFinite(remainingMs) && remainingMs >= 0) ||
			!Number.isSafeInteger(retryAfterMs) ||
			!(Number.isSafeInteger(limit) && limit > 0) ||
			!(Number.isSafeInteger(remainingUses) && remainingUses >= 0 && remainingUses <= limit)
		) {
			throw new TypeError('Atomic cooldown adapter returned an invalid result.');
		}
		const allowed = allowedValue === 1;

		if (!allowed) {
			return {
				allowed: false,
				remainingMs,
				retryAfter: new Date(retryAfterMs),
				limit,
				remainingUses,
				key,
			};
		}

		return {
			allowed: true,
			remainingMs: 0,
			retryAfter: new Date(retryAfterMs),
			limit,
			remainingUses,
			key,
		};
	}

	/**
	 * Inspect the bucket without consuming uses.
	 * Returns `undefined` when the command resolves to no cooldown.
	 */
	check(): ReturnCache<CooldownResult | undefined>;
	check(options: CooldownImplicitOptions): ReturnCache<CooldownResult | undefined>;
	check(options: CooldownCheckOptions): ReturnCache<CooldownResult | undefined>;
	check(options?: CooldownCheckOptions | CooldownImplicitOptions): ReturnCache<CooldownResult | undefined> {
		const resolved = this.resolveBucket(options);
		if (!resolved) return undefined;

		const { props, key } = resolved;
		const cost = options?.cost ?? 1;
		const limit = this.resolveLimit(props);
		const interval = this.resolveInterval(props);
		this.assertCostWithinLimit(cost, limit);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (!data) {
				return this.allowedResult(key, limit, limit - cost, now);
			}

			const state = this.resolveStoredBucket(data, limit, interval, now);
			if (state.expired) {
				return this.allowedResult(key, limit, limit - cost, now);
			}

			const allowed = state.remaining - cost >= 0;
			const remainingMs = interval - state.elapsed;
			if (!allowed) return this.rateLimitedResult(key, limit, state.remaining, now, remainingMs);
			return this.allowedResult(key, limit, state.remaining - cost, now);
		});
	}

	/**
	 * Consume uses from the bucket.
	 * Returns `undefined` when the command resolves to no cooldown.
	 */
	consume(): ReturnCache<CooldownResult | undefined>;
	consume(options: CooldownImplicitOptions): ReturnCache<CooldownResult | undefined>;
	consume(options: CooldownConsumeOptions): ReturnCache<CooldownResult | undefined>;
	consume(options?: CooldownConsumeOptions | CooldownImplicitOptions): ReturnCache<CooldownResult | undefined> {
		const resolved = this.resolveBucket(options);
		if (!resolved) return undefined;

		const { props, key } = resolved;
		const cost = options?.cost ?? 1;
		const limit = this.resolveLimit(props);
		const interval = this.resolveInterval(props);
		this.assertCostWithinLimit(cost, limit);

		this.debugger?.info(`Consuming cooldown ${key} (cost=${cost})`);

		const atomicAdapter = this.getAtomicAdapter();
		if (atomicAdapter) return this.consumeAtomic(atomicAdapter, key, props, limit, cost);
		return this.mutate(key, () => this.consumeStoredBucket(key, interval, limit, cost));
	}

	private consumeStoredBucket(key: string, interval: number, limit: number, cost: number): ReturnCache<CooldownResult> {
		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();
			const state = data ? this.resolveStoredBucket(data, limit, interval, now) : undefined;
			if (!state || state.expired) {
				const remaining = limit - cost;
				const write = data
					? this.resource.patch(CacheFrom.Gateway, key, { interval, lastDrip: now, remaining })
					: this.resource.set(CacheFrom.Gateway, key, { interval, lastDrip: now, remaining });
				return fakePromise(write).then(() => this.allowedResult(key, limit, remaining, now));
			}

			if (state.remaining - cost < 0) {
				return this.rateLimitedResult(key, limit, state.remaining, now, interval - state.elapsed);
			}

			const remaining = state.remaining - cost;
			return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { interval, remaining })).then(() =>
				this.allowedResult(key, limit, remaining, now),
			);
		});
	}

	private resolveStoredBucket(
		data: { lastDrip: number; remaining: number },
		limit: number,
		interval: number,
		now: number,
	) {
		if (
			!Number.isSafeInteger(data.lastDrip) ||
			data.lastDrip > now ||
			!Number.isSafeInteger(data.remaining) ||
			data.remaining < 0 ||
			data.remaining > limit
		) {
			return { elapsed: interval, expired: true, remaining: limit };
		}
		const elapsed = now - data.lastDrip;
		return {
			elapsed,
			expired: elapsed >= interval,
			remaining: data.remaining,
		};
	}

	/** Clear the bucket. Returns false when no cooldown is configured. */
	reset(): ReturnCache<boolean>;
	reset(options: CooldownResetOptions): ReturnCache<boolean>;
	reset(options?: CooldownResetOptions): ReturnCache<boolean> {
		const resolved = options ? this.resolveExplicitBucket(options) : this.resolveScopedBucket();
		if (!resolved) return false;
		const { key } = resolved;
		this.debugger?.info(`Resetting cooldown ${key}`);
		return this.mutate(key, () => fakePromise(this.resource.remove(key)).then(() => true));
	}

	private resolveContextTarget(context: CooldownContextLike, props: CooldownProps): string | undefined {
		const type = props.type;
		if (typeof type === 'function') return type(context as AnyContext);
		switch (type) {
			case 'guild':
				return context.guildId ?? context.author?.id;
			case 'channel':
				return context.channelId ?? context.author?.id;
			case 'global':
				return 'global';
			default:
				return context.author?.id;
		}
	}
}

function isExplicitOptions(
	options: CooldownCheckOptions | CooldownImplicitOptions | undefined,
): options is CooldownCheckOptions {
	return (
		!!options &&
		typeof (options as CooldownCheckOptions).name === 'string' &&
		typeof (options as CooldownCheckOptions).target === 'string'
	);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}
