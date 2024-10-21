import type { AnyContext, SubCommand } from 'seyfert';
import type { ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import { type MakePartial, fakePromise } from 'seyfert/lib/common';
import { type CooldownData, CooldownResource, type CooldownType } from './resource';

export class CooldownManager {
	resource: CooldownResource;
	constructor(public readonly client: BaseClient) {
		this.resource = new CooldownResource(client.cache, client);
	}

	/**
	 * Get the cooldown data for a command
	 * @param name - The name of the command
	 * @returns The cooldown data for the command
	 */
	getCommandData(name: string): CooldownProps | undefined {
		if (!this.client.commands?.values?.length) return;
		for (const command of this.client.commands.values) {
			if (!('cooldown' in command)) continue;
			if (command.name === name) return command.cooldown;
			if ('options' in command)
				return command.options?.find((x): x is SubCommand => 'cooldown' in x && x.name === name)?.cooldown;
		}
		return undefined;
	}

	/**
	 * Check if a user has a cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns Whether the user has a cooldown
	 */
	has(name: string, target: string, tokens = 1): ReturnCache<boolean> {
		const data = this.getCommandData(name);
		if (!data) return false;

		return fakePromise(this.resource.get(`${name}:${data.type}:${target}`)).then(cooldown => {
			if (tokens > data.uses) return true;
			if (!cooldown) {
				return fakePromise(
					this.set(name, target, { type: data.type, interval: data.interval, remaining: data.uses }),
				).then(() => false);
			}

			const remaining = Math.max(cooldown.remaining - tokens, 0);

			return remaining === 0;
		});
	}

	set(
		name: string,
		target: string,
		{ type, ...data }: MakePartial<CooldownData, 'lastDrip'> & { type: `${CooldownType}` },
	) {
		return this.resource.set(`${name}:${type}:${target}`, data);
	}

	context(context: AnyContext) {
		if (!('command' in context)) return true;
		if (!('name' in context.command)) return true;

		const cd = context.command.cooldown;
		if (!cd) return true;

		let target: string | undefined;
		switch (cd.type) {
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
		return this.use(context.command.name, target);
	}

	/**
	 * Use a cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns The remaining cooldown in seconds or true if successful
	 */
	use(name: string, target: string): ReturnCache<number | true> {
		const data = this.getCommandData(name);
		if (!data) return true;

		return fakePromise(this.resource.get(`${name}:${data.type}:${target}`)).then(cooldown => {
			if (!cooldown) {
				return fakePromise(
					this.set(name, target, {
						type: data.type,
						interval: data.interval,
						remaining: data.uses - 1,
					}),
				).then(() => true);
			}

			return fakePromise(this.drip(name, target, data, cooldown)).then(drip => {
				return typeof drip === 'number' ? data.interval - drip : true;
			});
		});
	}

	/**
	 * Drip the cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @param props - The cooldown properties
	 * @param data - The cooldown data
	 * @returns The cooldown was processed
	 */
	drip(name: string, target: string, props: CooldownProps, data: CooldownData): ReturnCache<boolean | number> {
		const now = Date.now();
		const deltaMS = now - data.lastDrip;
		if (deltaMS >= props.interval) {
			return fakePromise(
				this.resource.patch(`${name}:${props.type}:${target}`, {
					lastDrip: now,
					remaining: props.uses - 1,
				}),
			).then(() => true);
		}

		if (data.remaining - 1 < 0) {
			return deltaMS;
		}

		return fakePromise(this.resource.patch(`${name}:${props.type}:${target}`, { remaining: data.remaining - 1 })).then(
			() => true,
		);
	}

	/**
	 * Refill the cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns Whether the cooldown was refilled
	 */
	refill(name: string, target: string) {
		const data = this.getCommandData(name);
		if (!data) return false;

		return fakePromise(this.resource.patch(`${name}:${data.type}:${target}`, { remaining: data.uses })).then(
			() => true,
		);
	}
}

export interface CooldownProps {
	/** target type */
	type: `${CooldownType}`;
	/** interval in ms */
	interval: number;
	/** refill amount */
	uses: number;
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
