import { BaseResource, type CacheFrom } from 'seyfert/lib/cache';
import type { PickPartial } from 'seyfert/lib/common';

export const COOLDOWN_RESOURCE_NAMESPACE = 'cooldowns';
export const COOLDOWN_RESOURCE_FIELD_PREFIX = 'N_';
export const COOLDOWN_RESOURCE_RELATIONSHIP_SUFFIX = ':set';

export interface CooldownData {
	remaining: number;
	interval: number;
	lastDrip: number;
}

export class CooldownResource extends BaseResource<CooldownData> {
	namespace = COOLDOWN_RESOURCE_NAMESPACE;

	filter(_data: CooldownData, _id: string): boolean {
		return true;
	}

	override set(from: CacheFrom, id: string, data: PickPartial<CooldownData, 'lastDrip'>) {
		return super.set(from, id, { ...data, lastDrip: data.lastDrip ?? Date.now() });
	}
}
