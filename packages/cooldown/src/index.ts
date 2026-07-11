import './seyfert';
import type { CooldownProps, CooldownTargetResolver, CooldownTargetType } from './manager';

export * from './manager';
export * from './plugin';

export interface CooldownDecoratorOptions {
	uses?: number;
	group?: string;
}

function decorate(props: CooldownProps): ClassDecorator {
	return target => {
		const command = target as unknown as new (...args: any[]) => object;
		const decorated = class extends command {
			cooldown = props;
		};
		return decorated as unknown as typeof target;
	};
}

/**
 * Class decorator that assigns a `CooldownProps` payload to the command class.
 *
 * Also exposes typed shortcuts for the built-in target scopes:
 *  - `Cooldown.user(interval, options?)`
 *  - `Cooldown.guild(interval, options?)`
 *  - `Cooldown.channel(interval, options?)`
 *  - `Cooldown.global(interval, options?)`
 *  - `Cooldown.custom(resolver, interval, options?)` for custom target resolvers
 */
export function Cooldown(props: CooldownProps) {
	return decorate(props);
}

function scopedShortcut(type: CooldownTargetType) {
	return (interval: number, options: CooldownDecoratorOptions = {}) =>
		decorate({ type, interval, uses: options.uses ?? 1, group: options.group });
}

Cooldown.user = scopedShortcut('user');
Cooldown.guild = scopedShortcut('guild');
Cooldown.channel = scopedShortcut('channel');
Cooldown.global = scopedShortcut('global');
Cooldown.custom = (resolver: CooldownTargetResolver, interval: number, options: CooldownDecoratorOptions = {}) =>
	decorate({ type: resolver, interval, uses: options.uses ?? 1, group: options.group });
