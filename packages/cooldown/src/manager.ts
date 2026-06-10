import { AsyncLocalStorage } from 'node:async_hooks';
import {
	type AnyContext,
	type ContextScope,
	createPlugin,
	Formatter,
	type MiddlewareContext,
	type PluginMiddlewareMap,
	type SeyfertPlugin,
} from 'seyfert';
import { CacheFrom, type ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import type { UsingClient } from 'seyfert/lib/commands';
import type { CommandFromContent } from 'seyfert/lib/commands/handle';
import { type Awaitable, fakePromise } from 'seyfert/lib/common';
import { COOLDOWN_RESOURCE_FIELD_PREFIX, COOLDOWN_RESOURCE_RELATIONSHIP_SUFFIX, CooldownResource } from './resource';

export type CooldownTargetType = 'user' | 'guild' | 'channel' | 'global';
export type CooldownTargetResolver = (context: AnyContext) => string | undefined;

const cooldownContexts = new AsyncLocalStorage<AnyContext>();

export type CooldownMiddlewareMessage = string | ((result: CooldownResult, context: AnyContext) => string);

export interface CooldownMiddlewareOptions {
	global?: boolean;
	message?: CooldownMiddlewareMessage;
	name?: string;
}

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

export type CooldownMiddleware = MiddlewareContext<CooldownResult | undefined, AnyContext>;
export type CooldownMiddlewares<Name extends string = 'cooldown'> = Record<Name, CooldownMiddleware>;

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
	resolvedName: string;
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

if remaining == nil or lastDrip == nil or now - lastDrip >= interval then
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

	constructor(client?: BaseClient) {
		if (client) this.attach(client);
	}

	/** @internal */
	attach(client: BaseClient): this {
		this._client = client;
		const target = client as BaseClient & { cooldown?: CooldownManager };
		if (target.cooldown !== this) target.cooldown = this;
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

	private resolveCommand(name: string, guildId?: string) {
		const content = name.trim();
		const parts = content.split(' ').filter(Boolean).slice(0, 3);
		let fallback: CommandFromContent | undefined;

		for (const candidateGuildId of this.commandResolverGuildIds(guildId)) {
			const resolved = this.resolveCommandWithGuild(content, parts, candidateGuildId);
			if (resolved.command) return resolved;
			fallback ??= resolved;
		}

		return fallback ?? { fullCommandName: parts.join(' ') };
	}

	private resolveCommandWithGuild(content: string, parts: string[], guildId?: string) {
		let resolved: CommandFromContent | undefined;

		try {
			const message = { guild_id: guildId } as Parameters<
				typeof this.client.handleCommand.resolveCommandFromContent
			>[2];
			resolved = this.client.handleCommand.resolveCommandFromContent(content, '', message);
		} catch {
			resolved = undefined;
		}

		if (resolved?.command) return resolved;

		return this.client.handleCommand.getCommandFromContent(parts, guildId);
	}

	private *commandResolverGuildIds(guildId?: string): Iterable<string | undefined> {
		yield guildId;
	}

	private getFullCommandName({ command, parent, fullCommandName }: CommandFromContent) {
		if (!command) return fullCommandName;
		if (parent && command !== parent)
			return [parent.name, 'group' in command ? command.group : undefined, command.name].filter(Boolean).join(' ');
		return command.name || fullCommandName;
	}

	private getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
		this.debugger?.info(`Resolving cooldown data for command ${name} with guildId ${guildId}`);

		const { command, parent, fullCommandName } = this.resolveCommand(name, guildId);

		if (!command) return undefined;

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
		if (props.type === 'global') return `${namespace}:global:global`;
		const typeLabel = typeof props.type === 'function' ? 'custom' : (props.type ?? 'user');
		return `${namespace}:${typeLabel}:${target}`;
	}

	private resolveExplicitBucket(options: CooldownCheckOptions): ResolvedBucket | undefined {
		const [resolvedName, props] = this.getCommandData(options.name, options.guildId) ?? [];
		if (!(resolvedName && props)) return undefined;
		return { props, resolvedName, key: this.buildKey(props, resolvedName, options.target) };
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
		return { props, resolvedName, key: this.buildKey(props, resolvedName, target) };
	}

	private resolveBucket(
		options: CooldownCheckOptions | CooldownImplicitOptions | undefined,
	): ResolvedBucket | undefined {
		if (isExplicitOptions(options)) return this.resolveExplicitBucket(options);
		return this.resolveScopedBucket();
	}

	private getCooldownContext(): CooldownContextLike {
		const context = cooldownContexts.getStore() as CooldownContextLike | undefined;
		if (!context) {
			throw new Error(
				'Cannot resolve an implicit cooldown outside of a Seyfert cooldown scope. Use the explicit form, for example client.cooldown.consume({ name, target, guildId }).',
			);
		}

		return context;
	}

	private resolveLimit(props: CooldownProps) {
		const limit = props.uses ?? 1;
		if (!(Number.isFinite(limit) && limit > 0)) throw new RangeError('Cooldown uses must be a positive number.');
		return limit;
	}

	private assertCostWithinLimit(cost: number, limit: number) {
		if (!(Number.isFinite(cost) && cost > 0)) throw new RangeError('Cooldown cost must be a positive number.');
		if (cost > limit) throw new RangeError(`Cooldown cost (${cost}) cannot exceed the bucket limit (${limit}).`);
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
		const allowed = Number(result[0]) === 1;
		const remainingMs = Number(result[1]);
		const retryAfterMs = Number(result[2]);
		const limit = Number(result[3]);
		const remainingUses = Number(result[4]);

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
		this.assertCostWithinLimit(cost, limit);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (!data) {
				return this.allowedResult(key, limit, limit - cost, now);
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				return this.allowedResult(key, limit, limit - cost, now);
			}

			const allowed = data.remaining - cost >= 0;
			const remainingMs = Math.max(props.interval - elapsed, 0);
			if (!allowed) return this.rateLimitedResult(key, limit, data.remaining, now, remainingMs);
			return this.allowedResult(key, limit, data.remaining - cost, now);
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
		this.assertCostWithinLimit(cost, limit);

		this.debugger?.info(`Consuming cooldown ${key} (cost=${cost})`);

		const atomicAdapter = this.getAtomicAdapter();
		if (atomicAdapter) return this.consumeAtomic(atomicAdapter, key, props, limit, cost);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (!data) {
				const remaining = limit - cost;
				return fakePromise(
					this.resource.set(CacheFrom.Gateway, key, {
						interval: props.interval,
						remaining,
					}),
				).then(() => this.allowedResult(key, limit, remaining, now));
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				const remaining = limit - cost;
				return fakePromise(
					this.resource.patch(CacheFrom.Gateway, key, {
						lastDrip: now,
						remaining,
					}),
				).then(() => this.allowedResult(key, limit, remaining, now));
			}

			if (data.remaining - cost < 0) {
				const remainingMs = props.interval - elapsed;
				return this.rateLimitedResult(key, limit, data.remaining, now, remainingMs);
			}

			const remaining = data.remaining - cost;
			return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { remaining })).then(() =>
				this.allowedResult(key, limit, remaining, now),
			);
		});
	}

	/** Clear the bucket. Returns false when no cooldown is configured. */
	reset(): ReturnCache<boolean>;
	reset(options: CooldownResetOptions): ReturnCache<boolean>;
	reset(options?: CooldownResetOptions): ReturnCache<boolean> {
		const resolved = options ? this.resolveExplicitBucket(options) : this.resolveScopedBucket();
		if (!resolved) return false;
		const { key } = resolved;
		this.debugger?.info(`Resetting cooldown ${key}`);
		return fakePromise(this.resource.remove(key)).then(() => true);
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

export interface CooldownPluginOptions {
	middleware?: boolean | CooldownMiddlewareOptions;
}

export type CooldownPluginMiddlewares<TOptions> = TOptions extends { middleware: true } ? CooldownMiddlewares : {};

export interface CooldownPlugin<TMiddlewares extends PluginMiddlewareMap = {}>
	extends SeyfertPlugin<{ cooldown: CooldownManager }, { cooldown: CooldownManager }, readonly [], TMiddlewares> {
	name: '@slipher/cooldown';
	manager: CooldownManager;
	setup(client: BaseClient): void;
}

export function cooldown<const TOptions extends CooldownPluginOptions = {}>(
	options: TOptions = {} as TOptions,
): CooldownPlugin<CooldownPluginMiddlewares<TOptions>> {
	const manager = new CooldownManager();
	const contextScope: ContextScope = (context, run) => cooldownContexts.run(context as AnyContext, run);
	const middleware = resolveCooldownMiddleware(options.middleware, manager);

	return createPlugin({
		name: '@slipher/cooldown',
		manager,
		client: {
			cooldown: () => manager,
		},
		ctx: {
			cooldown: () => manager,
		},
		register(api) {
			if (middleware) {
				api.middlewares.add(
					middleware.name,
					middleware.run,
					middleware.global === undefined ? undefined : { global: middleware.global },
				);
			}
			api.options.set({ contextScopes: [contextScope] });
		},
		setup(client) {
			manager.attach(client);
		},
	}) as CooldownPlugin<CooldownPluginMiddlewares<TOptions>>;
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

function resolveCooldownMiddleware(input: CooldownPluginOptions['middleware'], manager: CooldownManager) {
	if (!input) return undefined;
	const options = input === true ? {} : input;
	return {
		global: options.global,
		name: options.name ?? 'cooldown',
		run: createCooldownMiddleware(manager, options),
	};
}

function createCooldownMiddleware(manager: CooldownManager, options: CooldownMiddlewareOptions): CooldownMiddleware {
	return async ({ context, next, stop }) => {
		const result = await manager.consume();
		if (!result || result.allowed) return next(result);
		return stop(resolveCooldownMiddlewareMessage(result, context, options.message));
	};
}

function resolveCooldownMiddlewareMessage(
	result: CooldownResult & { allowed: false },
	context: AnyContext,
	message?: CooldownMiddlewareMessage,
) {
	if (typeof message === 'function') return message(result, context);
	if (message) return message;
	return `This command is cooling down. Try again ${Formatter.timestamp(result.retryAfter)}.`;
}
