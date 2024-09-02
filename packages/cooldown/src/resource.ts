import { BaseResource } from 'seyfert/lib/cache/resources/default/base';
import { getMilliseconds } from './clock';

export interface CooldownData {
	remaining: number;
	interval: number;
	lastDrip: number;
}

export type CooldownDataInsert = Omit<CooldownData, 'lastDrip'>;

export enum CooldownType {
	User = 'user',
	Guild = 'guild',
	Channel = 'channel',
}

export class Cooldowns extends BaseResource<CooldownData> {
	namespace = 'cooldowns';

	filter(_data: CooldownData, _id: string): boolean {
		return true;
	}

	override set(id: string, data: CooldownDataInsert) {
		return super.set(id, { ...data, lastDrip: getMilliseconds() });
	}
}
