import type { AnyContext } from 'seyfert';
import type { BaseClient } from 'seyfert/lib/client/base';
import { type CooldownContextScope, CooldownManager, type CooldownProps, runWithCooldownContext } from './manager';

export * from './manager';
export * from './resource';

export interface CooldownClient extends BaseClient {
	cooldown?: CooldownManager;
}

export interface CooldownPlugin {
	name: '@slipher/cooldown';
	options(): {
		context: () => { cooldown: CooldownManager };
		contextScopes: readonly CooldownContextScope[];
	};
	setup(client: CooldownClient): void;
}

export function cooldown(): CooldownPlugin {
	let manager: CooldownManager | undefined;

	const contextScope: CooldownContextScope = (context, run) => runWithCooldownContext(context as AnyContext, run);
	const getManager = () => {
		if (!manager) throw new Error('@slipher/cooldown plugin setup has not run yet.');

		return manager;
	};

	return {
		name: '@slipher/cooldown',
		options: () => ({
			context: () => ({ cooldown: getManager() }),
			contextScopes: [contextScope],
		}),
		setup: client => {
			manager = new CooldownManager(client);
			client.cooldown = manager;
		},
	};
}

export function Cooldown(props: CooldownProps) {
	return <T extends { new (...args: any[]): {} }>(target: T) =>
		class extends target {
			cooldown = props;
		};
}
