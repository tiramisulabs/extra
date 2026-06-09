import type {} from 'seyfert';
import type { CooldownProps } from './manager';

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
