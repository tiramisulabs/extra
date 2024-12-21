import { BaseResource } from 'seyfert/lib/cache';
import type { PickPartial } from 'seyfert/lib/common';

export interface CooldownData {
	remaining: number;
	interval: number;
	lastDrip: number;
}

export enum CooldownType {
	User = 'user',
	Guild = 'guild',
	Channel = 'channel',
}

export class CooldownResource extends BaseResource<CooldownData> {
	namespace = 'cooldowns';

	filter(_data: CooldownData, _id: string): boolean {
		return true;
	}

	override set(id: string, data: PickPartial<CooldownData, 'lastDrip'>) {
		return super.set(id, { ...data, lastDrip: data.lastDrip ?? Date.now() });
	}
}
