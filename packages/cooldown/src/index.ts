import './seyfert';
import type { CooldownProps, CooldownTargetResolver, CooldownTargetType, UsesProps } from './manager';

export * from './manager';
export * from './resource';

const DEFAULT_USES: UsesProps = { default: 1 };

function decorate(props: CooldownProps) {
	return <T extends { new (...args: any[]): {} }>(target: T) =>
		class extends target {
			cooldown = props;
		};
}

/**
 * Class decorator that assigns a `CooldownProps` payload to the command class.
 *
 * Also exposes typed shortcuts for the built-in target scopes:
 *  - `Cooldown.user(interval, uses?)`
 *  - `Cooldown.guild(interval, uses?)`
 *  - `Cooldown.channel(interval, uses?)`
 *  - `Cooldown.global(interval, uses?)`
 *  - `Cooldown.custom(resolver, interval, uses?)` for custom target resolvers
 *
 * All shortcuts accept an optional `group` field via the third argument:
 * `Cooldown.user(5_000, { default: 1 }, { group: 'moderation' })`
 */
export function Cooldown(props: CooldownProps) {
	return decorate(props);
}

export interface CooldownDecoratorExtras {
	group?: string;
}

function scopedShortcut(type: CooldownTargetType) {
	return (interval: number, uses: UsesProps = DEFAULT_USES, extras: CooldownDecoratorExtras = {}) =>
		decorate({ type, interval, uses, group: extras.group });
}

Cooldown.user = scopedShortcut('user');
Cooldown.guild = scopedShortcut('guild');
Cooldown.channel = scopedShortcut('channel');
Cooldown.global = scopedShortcut('global');
Cooldown.custom = (
	resolver: CooldownTargetResolver,
	interval: number,
	uses: UsesProps = DEFAULT_USES,
	extras: CooldownDecoratorExtras = {},
) => decorate({ type: resolver, interval, uses, group: extras.group });
