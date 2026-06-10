import type {} from 'seyfert';
import type { CooldownManager, CooldownProps } from './manager';

declare module 'seyfert' {
	interface RegisteredPluginServices {
		cooldown: CooldownManager;
	}

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
