import type { CooldownMiddleware, CooldownProps } from './manager';

declare module 'seyfert' {
	interface RegisteredMiddlewares {
		cooldown: CooldownMiddleware;
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
