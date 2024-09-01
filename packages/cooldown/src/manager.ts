import type { UsingClient } from 'seyfert';
import { type CooldownData, type CooldownDataInsert, Cooldowns, type CooldownType } from './resource';
import { getMilliseconds } from './clock';

export class CooldownManager {
	resource: Cooldowns;
	constructor(readonly client: UsingClient) {
		this.resource = new Cooldowns(client.cache, client);
	}

	/**
	 * Get the cooldown data for a command
	 * @param name - The name of the command
	 * @returns The cooldown data for the command
	 */
	getData(name: string): CooldownProps | undefined {
		return this.client.commands?.values.find(x => x.name === name)?.cooldown;
	}

	/**
	 * Check if a user has a cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns Whether the user has a cooldown
	 */
	has(name: string, target: string) {
		const data = this.getData(name);
		if (!data) return false;

		const cooldown = this.resource.get(`${name}:${data.type}:${target}`);
		if (!cooldown) {
			this.set(name, target, { type: data.type, interval: data.interval, remaining: data.refill - data.tokens });
			return false;
		}

		const remaining = cooldown.remaining - data.tokens;

		if (remaining <= 0) return true;
		return false;
	}

	/**
	 * Use a cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @param tokens - The number of tokens to use
	 * @returns The remaining cooldown
	 */
	use(name: string, target: string, tokens?: number) {
		const data = this.getData(name);
		if (!data) return;

		const cooldown = this.resource.get(`${name}:${data.type}:${target}`);
		if (!cooldown) {
			this.set(name, target, {
				type: data.type,
				interval: data.interval,
				remaining: data.refill - (tokens ?? data.tokens),
			});
			return true;
		}

		const drip = this.drip(name, target, data, cooldown);

		if (drip.remaining <= 0) return false;

		return true;
	}

	/**
	 * Refill the cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @returns Whether the cooldown was refilled
	 */
	refill(name: string, target: string, tokens?: number) {
		const data = this.getData(name);
		if (!data) return false;

		const refill = tokens ?? data.refill;

		const cooldown = this.resource.get(`${name}:${data.type}:${target}`);
		if (!cooldown) {
			this.set(name, target, {
				type: data.type,
				interval: data.interval,
				remaining: refill,
			});
			return true;
		}

		this.set(name, target, { type: data.type, interval: data.interval, remaining: refill });
		return true;
	}

	/**
	 * Set the cooldown data for a command
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @param data - The cooldown data to set
	 */
	set(name: string, target: string, data: CooldownDataInsert & { type: `${CooldownType}` }) {
		this.resource.set(`${name}:${data.type}:${target}`, data);
	}

	/**
	 * Drip the cooldown
	 * @param name - The name of the command
	 * @param target - The target of the cooldown
	 * @param props - The cooldown properties
	 * @param data - The cooldown data
	 * @returns The remaining cooldown
	 */
	drip(name: string, target: string, props: CooldownProps, data: CooldownData) {
		const now = getMilliseconds();
		const deltaMS = Math.max(now - data.lastDrip, 0);
		data.lastDrip = now;

		const dripAmount = deltaMS * (props.refill / props.interval);
		data.remaining = Math.min(data.remaining + dripAmount, props.refill);
		const result = { type: props.type, interval: props.interval, remaining: data.remaining };
		this.set(name, target, result);
		return result;
	}
}

export interface CooldownProps {
	/** target type */
	type: `${CooldownType}`;
	/** interval in ms */
	interval: number;
	/** refill amount */
	refill: number;
	/** tokens to use */
	tokens: number;
	/** byPass users */
	byPass?: string[];
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
}
