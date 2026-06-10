import { AsyncLocalStorage } from 'node:async_hooks';
import { type AnyContext, type ContextScope, createPlugin, createServiceKey, type SeyfertPlugin } from 'seyfert';
import { CacheFrom, type ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import type { UsingClient } from 'seyfert/lib/commands';
import type { CommandFromContent } from 'seyfert/lib/commands/handle';
import { type Awaitable, fakePromise, type PickPartial } from 'seyfert/lib/common';
import { type CooldownData, CooldownResource, type CooldownType } from './resource';

export type CooldownTargetType = `${CooldownType}` | 'global';
export type CooldownTargetResolver = (context: AnyContext) => string | undefined;

const cooldownContexts = new AsyncLocalStorage<AnyContext>();

export type CooldownContextScope = ContextScope;
export const cooldownService = createServiceKey<CooldownManager>('cooldown');

export interface CooldownContextOptions {
	use?: keyof UsesProps;
	guildId?: string;
}

export function runWithCooldownContext<T>(context: AnyContext, run: () => Awaitable<T>) {
	return cooldownContexts.run(context, run);
}

export function useCooldownContext() {
	const context = cooldownContexts.getStore();
	if (!context) throw new Error('Cannot access cooldown context outside of a Seyfert cooldown scope.');

	return context;
}

export interface UsesProps {
	default: number;
	[variant: string]: number;
}

export interface CooldownProps {
	/** Cooldown target. Either a built-in scope or a resolver invoked with the active context. */
	type?: CooldownTargetType | CooldownTargetResolver;
	/** Interval in ms before a token refills. */
	interval: number;
	/** Available tokens per variant. `default` is required. */
	uses: UsesProps;
	/** Shared bucket name. When set, the cache key uses this name instead of the resolved command. */
	group?: string;
}

export type CooldownDenyReason = 'rate_limited' | 'over_capacity';

interface CooldownResultBase {
	/** Maximum tokens for the resolved variant. */
	limit: number;
	/** Tokens still available after the operation. */
	remainingUses: number;
	/** Cache key used by this operation, useful for logging and metrics. */
	key: string;
}

export type CooldownResult =
	| (CooldownResultBase & {
			allowed: true;
			reason?: undefined;
			remainingMs: 0;
			retryAfter: Date;
	  })
	| (CooldownResultBase & {
			allowed: false;
			reason: 'rate_limited';
			remainingMs: number;
			retryAfter: Date;
	  })
	| (CooldownResultBase & {
			allowed: false;
			reason: 'over_capacity';
			remainingMs: number;
			retryAfter: null;
	  });

export interface CooldownCheckOptions {
	name: string;
	target: string;
	use?: keyof UsesProps;
	guildId?: string;
	tokens?: number;
}

export type CooldownConsumeOptions = CooldownCheckOptions;

export interface CooldownSetOptions extends PickPartial<CooldownData, 'lastDrip'> {
	key: string;
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
	reasonCode: number,
];

interface AtomicCooldownAdapter {
	eval<T = unknown>(script: string, keys: string[], args: string[]): Awaitable<T>;
}

const ATOMIC_CONSUME_SCRIPT = `
local hashKey = KEYS[1]
local namespaceKey = KEYS[2]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local tokens = tonumber(ARGV[4])
local memberKey = ARGV[5]

local remaining = tonumber(redis.call('HGET', hashKey, 'N_remaining'))
local lastDrip = tonumber(redis.call('HGET', hashKey, 'N_lastDrip'))

if tokens > limit then
	if remaining == nil then remaining = limit end
	return {0, -1, -1, limit, remaining, 2}
end

if remaining == nil or lastDrip == nil or now - lastDrip >= interval then
	local newRemaining = limit - tokens
	redis.call('SADD', namespaceKey .. ':set', memberKey)
	redis.call('HSET', hashKey, 'N_interval', tostring(interval), 'N_remaining', tostring(newRemaining), 'N_lastDrip', tostring(now))
	return {1, 0, now, limit, newRemaining, 0}
end

local elapsed = now - lastDrip
local newRemaining = remaining - tokens
if newRemaining < 0 then
	local remainingMs = interval - elapsed
	return {0, remainingMs, now + remainingMs, limit, remaining, 1}
end

redis.call('SADD', namespaceKey .. ':set', memberKey)
redis.call('HSET', hashKey, 'N_interval', tostring(interval), 'N_remaining', tostring(newRemaining))
return {1, 0, now, limit, newRemaining, 0}
`;

export class CooldownManager {
	private _client?: BaseClient;
	private _resource?: CooldownResource;

	constructor(client?: BaseClient) {
		if (client) this.attach(client);
	}

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
		if (guildId) {
			yield guildId;
			return;
		}

		yield undefined;
		for (const command of this.client.commands.values) {
			for (const commandGuildId of command.guildId ?? []) {
				yield commandGuildId;
			}
		}
	}

	private getFullCommandName({ command, parent, fullCommandName }: CommandFromContent) {
		if (!command) return fullCommandName;
		if (parent && command !== parent)
			return [parent.name, 'group' in command ? command.group : undefined, command.name].filter(Boolean).join(' ');
		return command.name || fullCommandName;
	}

	getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
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

	private resolveBucket(options: CooldownCheckOptions): ResolvedBucket | undefined {
		const [resolvedName, props] = this.getCommandData(options.name, options.guildId) ?? [];
		if (!(resolvedName && props)) return undefined;
		return { props, resolvedName, key: this.buildKey(props, resolvedName, options.target) };
	}

	private resolveLimit(props: CooldownProps, use?: keyof UsesProps) {
		const variant = use ?? 'default';
		const limit = props.uses[variant];
		if (typeof limit === 'number' && Number.isFinite(limit)) return { variant, limit };

		this.debugger?.warn(
			`Unknown cooldown use variant "${String(variant)}"; falling back to the "default" cooldown limit.`,
		);
		return { variant: 'default', limit: props.uses.default };
	}

	private overCapacityResult(key: string, limit: number, remainingUses: number): CooldownResult {
		return {
			allowed: false,
			reason: 'over_capacity',
			remainingMs: Infinity,
			retryAfter: null,
			limit,
			remainingUses,
			key,
		};
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
			reason: 'rate_limited',
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
		return typeof adapter.eval === 'function' ? (adapter as AtomicCooldownAdapter) : undefined;
	}

	private consumeAtomic(
		adapter: AtomicCooldownAdapter,
		key: string,
		props: CooldownProps,
		limit: number,
		tokens: number,
	): ReturnCache<CooldownResult> {
		const now = Date.now();
		return fakePromise(
			adapter.eval<AtomicCooldownResult>(
				ATOMIC_CONSUME_SCRIPT,
				[this.resource.hashId(key), this.resource.namespace],
				[String(now), String(props.interval), String(limit), String(tokens), key],
			),
		).then(result => this.fromAtomicResult(key, result));
	}

	private fromAtomicResult(key: string, result: AtomicCooldownResult): CooldownResult {
		const allowed = Number(result[0]) === 1;
		const remainingMs = Number(result[1]);
		const retryAfterMs = Number(result[2]);
		const limit = Number(result[3]);
		const remainingUses = Number(result[4]);
		const reasonCode = Number(result[5]);

		if (reasonCode === 2) return this.overCapacityResult(key, limit, remainingUses);
		if (!allowed) {
			return {
				allowed: false,
				reason: 'rate_limited',
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
	 * Inspect the bucket without consuming a token.
	 * Returns `undefined` when the command resolves to no cooldown.
	 */
	check(options: CooldownCheckOptions): ReturnCache<CooldownResult | undefined> {
		const resolved = this.resolveBucket(options);
		if (!resolved) return undefined;

		const { props, key } = resolved;
		const use = options.use ?? 'default';
		const tokens = options.tokens ?? 1;
		const { limit } = this.resolveLimit(props, use);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (tokens > limit) {
				return this.overCapacityResult(key, limit, data?.remaining ?? limit);
			}

			if (!data) {
				return this.allowedResult(key, limit, limit - tokens, now);
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				return this.allowedResult(key, limit, limit - tokens, now);
			}

			const allowed = data.remaining - tokens >= 0;
			const remainingMs = Math.max(props.interval - elapsed, 0);
			if (!allowed) return this.rateLimitedResult(key, limit, data.remaining, now, remainingMs);
			return this.allowedResult(key, limit, data.remaining - tokens, now);
		});
	}

	/**
	 * Consume a token from the bucket.
	 * Returns `undefined` when the command resolves to no cooldown.
	 */
	consume(options: CooldownConsumeOptions): ReturnCache<CooldownResult | undefined> {
		const resolved = this.resolveBucket(options);
		if (!resolved) return undefined;

		const { props, key } = resolved;
		const use = options.use ?? 'default';
		const tokens = options.tokens ?? 1;
		const { limit } = this.resolveLimit(props, use);

		this.debugger?.info(`Consuming cooldown ${key} (tokens=${tokens})`);

		const atomicAdapter = this.getAtomicAdapter();
		if (atomicAdapter && tokens <= limit) return this.consumeAtomic(atomicAdapter, key, props, limit, tokens);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (tokens > limit) {
				return this.overCapacityResult(key, limit, data?.remaining ?? limit);
			}

			if (!data) {
				const remaining = limit - tokens;
				return fakePromise(this.set({ key, interval: props.interval, remaining })).then(() =>
					this.allowedResult(key, limit, remaining, now),
				);
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				const remaining = limit - tokens;
				return fakePromise(
					this.resource.patch(CacheFrom.Gateway, key, {
						lastDrip: now,
						remaining,
					}),
				).then(() => this.allowedResult(key, limit, remaining, now));
			}

			if (data.remaining - tokens < 0) {
				const remainingMs = props.interval - elapsed;
				return this.rateLimitedResult(key, limit, data.remaining, now, remainingMs);
			}

			const remaining = data.remaining - tokens;
			return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { remaining })).then(() =>
				this.allowedResult(key, limit, remaining, now),
			);
		});
	}

	/** Milliseconds remaining before the bucket allows another consume. 0 when free or unconfigured. */
	remaining(options: CooldownCheckOptions): ReturnCache<number> {
		return fakePromise(this.check(options)).then(result => result?.remainingMs ?? 0);
	}

	/** Clear the bucket for a given command/target. Returns false when no cooldown is configured. */
	reset(name: string, target: string, use: keyof UsesProps = 'default'): ReturnCache<boolean> {
		const resolved = this.resolveBucket({ name, target });
		if (!resolved) return false;
		const { props, key } = resolved;
		const { limit } = this.resolveLimit(props, use);
		this.debugger?.info(`Resetting cooldown ${key}`);
		return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { remaining: limit })).then(() => true);
	}

	/** Low-level: write a bucket directly by its cache key. */
	set(options: CooldownSetOptions): Awaitable<void> {
		return this.resource.set(CacheFrom.Gateway, options.key, {
			interval: options.interval,
			remaining: options.remaining,
			lastDrip: options.lastDrip,
		});
	}

	/**
	 * Resolve target from the current interaction context and consume a token.
	 * Returns `undefined` when the command resolves to no cooldown or when a custom resolver yields no target.
	 */
	context(options: CooldownContextOptions = {}): ReturnCache<CooldownResult | undefined> {
		return this.contextFrom(useCooldownContext(), options.use, options.guildId);
	}

	private contextFrom(context: AnyContext, use?: keyof UsesProps, guildId?: string) {
		if (!('command' in context)) return undefined;
		if (!('fullCommandName' in context)) return undefined;
		const name = context.fullCommandName;

		const [resolvedName, props] = this.getCommandData(name, guildId) ?? [];
		if (!(resolvedName && props)) return undefined;

		const target = this.resolveContextTarget(context, props);
		if (target === undefined) return undefined;

		this.debugger?.info(`Using target ${target} for cooldown of command ${resolvedName}`);
		return this.consume({ name, target, use, guildId });
	}

	private resolveContextTarget(context: AnyContext, props: CooldownProps): string | undefined {
		const type = props.type;
		if (typeof type === 'function') return type(context);
		switch (type) {
			case 'guild':
				return context.guildId ?? context.author.id;
			case 'channel':
				return context.channelId ?? context.author.id;
			case 'global':
				return 'global';
			default:
				return context.author.id;
		}
	}
}

export interface CooldownPluginOptions {
	manager?: CooldownManager;
}

export interface CooldownPlugin extends SeyfertPlugin<{ cooldown: CooldownManager }, { cooldown: CooldownManager }> {
	name: '@slipher/cooldown';
	manager: CooldownManager;
	setup(client: BaseClient): void;
}

export function cooldown(options: CooldownPluginOptions = {}): CooldownPlugin {
	const manager = options.manager ?? new CooldownManager();
	const contextScope: CooldownContextScope = (context, run) => runWithCooldownContext(context as AnyContext, run);

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
			api.services.set(cooldownService, manager);
			api.options.set({ contextScopes: [contextScope] });
		},
		setup(client) {
			manager.attach(client);
		},
	});
}
