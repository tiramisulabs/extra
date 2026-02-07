import { AnyContext } from 'seyfert';
import { CacheFrom, type ReturnCache } from 'seyfert/lib/cache';
import type { BaseClient } from 'seyfert/lib/client/base';
import { fakePromise, type PickPartial } from 'seyfert/lib/common';
import { type CooldownData, CooldownResource, type CooldownType } from './resource';

export class CooldownManager {
	resource: CooldownResource;
	
	constructor(public readonly client: BaseClient) {
		this.resource = new CooldownResource(client.cache, client);
	}

	private get debugger() {
		return this.client.debugger
	}

	getCommandData(name: string, guildId?: string): [name: string, data: CooldownProps | undefined] | undefined {
		const { command, parent, fullCommandName }= this.client.handleCommand.getCommandFromContent(
			name
				.split(' ')
				.filter(x => x)
				.slice(0, 3),
		);

		this.debugger?.info(`Resolving cooldown data for command ${name} with guildId ${guildId}`);

		if (!command) return undefined;

		this.debugger?.info(`Found command ${command.name} for cooldown data resolution`);
		if (guildId) {
			this.debugger?.info(`Checking guild-specific cooldown for command ${command.name} and guildId ${guildId}`);
			if (command.guildId?.includes(guildId)) return [fullCommandName, command.cooldown];
			this.debugger?.info(`No guild-specific cooldown found for command ${command.name} and guildId ${guildId}`);
			return undefined;
		} 

		this.debugger?.info(`No guildId provided, checking for global cooldown for command ${command.name}`);
		return [fullCommandName, command.cooldown ?? parent?.cooldown]

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
		if (!('fullCommandName' in context)) return true;
		const name = context.fullCommandName;

		const [resolve, data] = this.getCommandData(name, guildId) ?? [];
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
		this.debugger?.info(`Using target ${target} for cooldown of type ${data.type}`);
		return this.use({ name, target, use, guildId }, [resolve, data]);
	}

	/**
	 * Use a cooldown
	 * @returns The remaining cooldown in seconds or true if successful
	 */
	use(options: CooldownUseOptions, resolveData?: [string, CooldownProps]): ReturnCache<number | true> {
		const [resolve, data] = resolveData ?? this.getCommandData(options.name, options.guildId) ?? [];
		if (!(data && resolve)) return true;

		this.debugger?.info(`Using cooldown for command ${options.name} and target ${options.target}`);
		return fakePromise(this.resource.get(`${resolve}:${data.type}:${options.target}`)).then(cooldown => {
			if (!cooldown) {
				this.debugger?.info(
					`No existing cooldown found for command ${options.name} and target ${options.target}, setting new cooldown`,
				);
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

			this.debugger?.info(`Found existing cooldown for command ${options.name} and target ${options.target}`);
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
			this.debugger?.info(`Cooldown expired for ${options.name} and target ${options.target}, resetting cooldown`);
			return fakePromise(
				this.resource.patch(CacheFrom.Gateway, `${options.name}:${options.props.type}:${options.target}`, {
					lastDrip: now,
					remaining: options.props.uses[options.use ?? 'default'] - 1,
				}),
			).then(() => true);
		}

		if (options.data.remaining - 1 < 0) {
			this.debugger?.info(`Cooldown still active for ${options.name} and target ${options.target}, cannot drip`);
			return deltaMS;
		}

		this.debugger?.info(`Dripping cooldown for ${options.name} and target ${options.target}`);
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

		this.debugger?.info(`Refilling cooldown for command ${name} and target ${target}`);
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
