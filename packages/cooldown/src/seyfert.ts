import type { AnyContext, MiddlewareContext } from 'seyfert';
import type { CooldownProps, CooldownResult } from './manager';

declare module 'seyfert' {
	interface RegisteredMiddlewares {
		cooldown: MiddlewareContext<CooldownResult | undefined, AnyContext>;
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
