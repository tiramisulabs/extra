import type { AnyContext, SubCommand } from 'seyfert';
import { CacheFrom, type ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import { fakePromise, type PickPartial } from 'seyfert/lib/common';
import { type CooldownData, CooldownResource, type CooldownType } from './resource';

export class CooldownManager {
	resource: CooldownResource;
	constructor(public readonly client: BaseClient) {
		this.resource = new CooldownResource(client.cache, client);
	}

	getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
		if (!this.client.commands?.values?.length) return;
		for (const command of this.client.commands.values) {
			if (!('cooldown' in command)) continue;
			if (guildId && command.guildId?.length && !command.guildId.includes(guildId)) continue;
			if (command.name === name) return [command.name, command.cooldown];
			if ('options' in command) {
				const option = command.options?.find((x): x is SubCommand => x.name === name);
				if (option) {
					return [option.name, option.cooldown ?? command.cooldown];
				}
			}
		}
		return undefined;
	}

	has(options: CooldownHasOptions): ReturnCache<boolean> {
		const [resolve, data] = this.getCommandData(options.name, options.guildId) ?? [];
		if (!(data && resolve)) return false;

		return fakePromise(this.resource.get(`${resolve}:${data.type}:${options.target}`)).then(cooldown => {
			if ((options.tokens ?? 1) > data.uses[options.use ?? 'default']) return true;
			if (!cooldown) {
				return fakePromise(
					this.set({
						name: resolve,
						target: options.target,
						type: data.type,
						interval: data.interval,
						remaining: data.uses[options.use ?? 'default'],
					}),
				).then(() => false);
			}

			const remaining = Math.max(cooldown.remaining - (options.tokens ?? 1), 0);

			return remaining === 0;
		});
	}

	set(options: CooldownSetOptions) {
		return this.resource.set(CacheFrom.Gateway, `${options.name}:${options.type}:${options.target}`, {
			interval: options.interval,
			remaining: options.remaining,
			lastDrip: options.lastDrip,
		});
	}

	context(context: AnyContext, use?: keyof UsesProps, guildId?: string) {
		if (!('command' in context)) return true;
		if (!('name' in context.command)) return true;

		const [resolve, data] = this.getCommandData(context.command.name, guildId) ?? [];
		if (!(data && resolve)) return true;

		let target: string | undefined;
		switch (data.type) {
			case 'user':
				target = context.author.id;
				break;
			case 'guild':
				target = context.guildId;
				break;
			case 'channel':
				target = context.channelId;
				break;
		}

		target ??= context.author.id;
		return this.use({ name: context.command.name, target, use, guildId }, [resolve, data]);
	}

	/**
	 * Use a cooldown
	 * @returns The remaining cooldown in seconds or true if successful
	 */
	use(options: CooldownUseOptions, resolveData?: [string, CooldownProps]): ReturnCache<number | true> {
		const [resolve, data] = resolveData ?? this.getCommandData(options.name, options.guildId) ?? [];
		if (!(data && resolve)) return true;

		return fakePromise(this.resource.get(`${resolve}:${data.type}:${options.target}`)).then(cooldown => {
			if (!cooldown) {
				return fakePromise(
					this.set({
						name: resolve,
						target: options.target,
						type: data.type,
						interval: data.interval,
						remaining: data.uses[options.use ?? 'default'] - 1,
					}),
				).then(() => true);
			}

			return fakePromise(
				this.drip({
					name: resolve,
					props: data,
					data: cooldown,
					target: options.target,
					use: options.use,
				}),
			).then(drip => {
				return typeof drip === 'number' ? data.interval - drip : true;
			});
		});
	}

	/**
	 * Drip the cooldown
	 * @returns The cooldown was processed
	 */
	drip(options: CooldownDripOptions): ReturnCache<boolean | number> {
		const now = Date.now();
		const deltaMS = now - options.data.lastDrip;
		if (deltaMS >= options.props.interval) {
			return fakePromise(
				this.resource.patch(CacheFrom.Gateway, `${options.name}:${options.props.type}:${options.target}`, {
					lastDrip: now,
					remaining: options.props.uses[options.use ?? 'default'] - 1,
				}),
			).then(() => true);
		}

		if (options.data.remaining - 1 < 0) {
			return deltaMS;
		}

		return fakePromise(
			this.resource.patch(CacheFrom.Gateway, `${options.name}:${options.props.type}:${options.target}`, {
				remaining: options.data.remaining - 1,
			}),
		).then(() => true);
	}

	/**
	 * Refill the cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns Whether the cooldown was refilled
	 */
	refill(name: string, target: string, use: keyof UsesProps = 'default') {
		const [resolve, data] = this.getCommandData(name) ?? [];
		if (!(data && resolve)) return false;

		return fakePromise(
			this.resource.patch(CacheFrom.Gateway, `${resolve}:${data.type}:${target}`, { remaining: data.uses[use] }),
		).then(() => true);
	}
}

export interface CooldownProps {
	/** target type */
	type: `${CooldownType}`;
	/** interval in ms */
	interval: number;
	/** refill amount */
	uses: UsesProps;
}

export interface CooldownUseOptions {
	name: string;
	target: string;
	use?: keyof UsesProps;
	guildId?: string;
}

export interface CooldownDripOptions extends Omit<CooldownUseOptions, 'guildId'> {
	props: CooldownProps;
	data: CooldownData;
}

export interface CooldownHasOptions extends CooldownUseOptions {
	tokens?: number;
}

export interface CooldownSetOptions extends PickPartial<CooldownData, 'lastDrip'> {
	name: string;
	target: string;
	type: `${CooldownType}`;
}

export interface UsesProps {
	default: number;
}

declare module 'seyfert' {
	interface Command {
		cooldown?: CooldownProps;
	}
	interface SubCommand {
		cooldown?: CooldownProps;
	}
	interface ContextMenuCommand {
		cooldown?: CooldownProps;
	}
	interface EntryPointCommand {
		cooldown?: CooldownProps;
	}
}
