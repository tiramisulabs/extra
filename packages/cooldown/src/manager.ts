import type { AnyContext } from 'seyfert';
import { CacheFrom, type ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import type { UsingClient } from 'seyfert/lib/commands';
import type { CommandFromContent } from 'seyfert/lib/commands/handle';
import { type Awaitable, Formatter, fakePromise, type PickPartial, TimestampStyle } from 'seyfert/lib/common';
import { type CooldownData, CooldownResource, type CooldownType } from './resource';

export type CooldownTargetType = `${CooldownType}` | 'global';
export type CooldownTargetResolver = (context: AnyContext) => string | undefined;

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

export interface CooldownResult {
	allowed: boolean;
	/** Milliseconds left until the bucket allows another consume. Always 0 when allowed. */
	remainingMs: number;
	/** Absolute timestamp at which the bucket allows another consume. */
	retryAfter: Date;
	/** Maximum tokens for the resolved variant. */
	limit: number;
	/** Tokens still available after the operation. */
	remainingUses: number;
	/** Cache key used by this operation, useful for logging and metrics. */
	key: string;
}

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

export class CooldownManager {
	private _client?: BaseClient;
	private _resource?: CooldownResource;

	constructor(client?: BaseClient) {
		if (client) this.attach(client);
	}

	attach(client: BaseClient): this {
		this._client = client;
		(client as BaseClient & { cooldown: CooldownManager }).cooldown = this;
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

	private resolveCommand(name: string) {
		const content = name.trim();
		let resolved: CommandFromContent | undefined;

		try {
			const message = undefined as unknown as Parameters<typeof this.client.handleCommand.resolveCommandFromContent>[2];
			resolved = this.client.handleCommand.resolveCommandFromContent(content, '', message);
		} catch {
			resolved = undefined;
		}

		if (resolved?.command) return resolved;

		return this.client.handleCommand.getCommandFromContent(content.split(' ').filter(Boolean).slice(0, 3));
	}

	private getFullCommandName({ command, parent, fullCommandName }: CommandFromContent) {
		if (!command) return fullCommandName;
		if (parent && command !== parent)
			return [parent.name, 'group' in command ? command.group : undefined, command.name].filter(Boolean).join(' ');
		return command.name || fullCommandName;
	}

	getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
		this.debugger?.info(`Resolving cooldown data for command ${name} with guildId ${guildId}`);

		const { command, parent, fullCommandName } = this.resolveCommand(name);

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
		const limit = props.uses[use];

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (tokens > limit) {
				return {
					allowed: false,
					remainingMs: props.interval,
					retryAfter: new Date(now + props.interval),
					limit,
					remainingUses: data?.remaining ?? limit,
					key,
				};
			}

			if (!data) {
				return {
					allowed: true,
					remainingMs: 0,
					retryAfter: new Date(now),
					limit,
					remainingUses: limit - tokens,
					key,
				};
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				return {
					allowed: true,
					remainingMs: 0,
					retryAfter: new Date(now),
					limit,
					remainingUses: limit - tokens,
					key,
				};
			}

			const allowed = data.remaining - tokens >= 0;
			const remainingMs = Math.max(props.interval - elapsed, 0);
			return {
				allowed,
				remainingMs: allowed ? 0 : remainingMs,
				retryAfter: new Date(now + (allowed ? 0 : remainingMs)),
				limit,
				remainingUses: allowed ? data.remaining - tokens : data.remaining,
				key,
			};
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
		const limit = props.uses[use];

		this.debugger?.info(`Consuming cooldown ${key} (tokens=${tokens})`);

		return fakePromise(this.resource.get(key)).then(data => {
			const now = Date.now();

			if (tokens > limit) {
				return {
					allowed: false,
					remainingMs: props.interval,
					retryAfter: new Date(now + props.interval),
					limit,
					remainingUses: data?.remaining ?? limit,
					key,
				};
			}

			if (!data) {
				const remaining = limit - tokens;
				return fakePromise(this.set({ key, interval: props.interval, remaining })).then(() => ({
					allowed: true,
					remainingMs: 0,
					retryAfter: new Date(now),
					limit,
					remainingUses: remaining,
					key,
				}));
			}

			const elapsed = now - data.lastDrip;
			if (elapsed >= props.interval) {
				const remaining = limit - tokens;
				return fakePromise(
					this.resource.patch(CacheFrom.Gateway, key, {
						lastDrip: now,
						remaining,
					}),
				).then(() => ({
					allowed: true,
					remainingMs: 0,
					retryAfter: new Date(now),
					limit,
					remainingUses: remaining,
					key,
				}));
			}

			if (data.remaining - tokens < 0) {
				const remainingMs = props.interval - elapsed;
				return {
					allowed: false,
					remainingMs,
					retryAfter: new Date(now + remainingMs),
					limit,
					remainingUses: data.remaining,
					key,
				};
			}

			const remaining = data.remaining - tokens;
			return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { remaining })).then(() => ({
				allowed: true,
				remainingMs: 0,
				retryAfter: new Date(now),
				limit,
				remainingUses: remaining,
				key,
			}));
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
		this.debugger?.info(`Resetting cooldown ${key}`);
		return fakePromise(this.resource.patch(CacheFrom.Gateway, key, { remaining: props.uses[use] })).then(() => true);
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
	context(context: AnyContext, use?: keyof UsesProps, guildId?: string): ReturnCache<CooldownResult | undefined> {
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

export interface FormatRemainingOptions {
	/** Output format. Defaults to `'text'`. */
	style?: 'text' | 'discord';
	/** Discord timestamp style. Only used when `style === 'discord'`. Defaults to `TimestampStyle.RelativeTime`. */
	discordStyle?: TimestampStyle;
	/** Override the reference "now" timestamp. Useful for tests. */
	now?: () => number;
}

/**
 * Format a cooldown duration as either a short human string or a Discord timestamp tag built with Seyfert's `Formatter`.
 *
 * Accepts either a millisecond duration (`number`) or an absolute target timestamp (`Date`).
 *
 * Text examples: `500 → "1s"`, `5000 → "5s"`, `90000 → "1m 30s"`, `3_600_000 → "1h"`.
 * Discord examples: `5000 → "<t:1717372805:R>"`, `result.retryAfter → "<t:1717372805:R>"`.
 */
export function formatRemaining(input: number | Date, options: FormatRemainingOptions = {}): string {
	const now = options.now?.() ?? Date.now();
	const targetMs = input instanceof Date ? input.getTime() : now + (Number.isFinite(input) ? Math.max(input, 0) : 0);

	if (options.style === 'discord') {
		return Formatter.timestamp(new Date(Math.max(0, targetMs)), options.discordStyle ?? TimestampStyle.RelativeTime);
	}

	const diffMs = Math.max(targetMs - now, 0);
	if (diffMs <= 0) return '0s';
	const totalSeconds = Math.ceil(diffMs / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const remSeconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return remSeconds ? `${totalMinutes}m ${remSeconds}s` : `${totalMinutes}m`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const remMinutes = totalMinutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

export interface CooldownPluginOptions {
	manager?: CooldownManager;
}

export interface CooldownPlugin {
	name: '@slipher/cooldown';
	manager: CooldownManager;
	options(): {
		context(): { cooldown: CooldownManager };
	};
	setup(client: BaseClient): void;
}

export function createCooldown(options: CooldownPluginOptions = {}): CooldownManager {
	return options.manager ?? new CooldownManager();
}

export function cooldown(options: CooldownPluginOptions = {}): CooldownPlugin {
	const manager = createCooldown(options);

	return {
		name: '@slipher/cooldown',
		manager,
		options() {
			return {
				context() {
					return { cooldown: manager };
				},
			};
		},
		setup(client) {
			installCooldown(client, manager);
		},
	};
}

export function installCooldown<TClient extends BaseClient>(
	client: TClient,
	manager: CooldownManager,
): CooldownManager {
	manager.attach(client);
	return manager;
}
