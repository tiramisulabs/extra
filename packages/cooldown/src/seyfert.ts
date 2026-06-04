import type {} from 'seyfert';
import type { CooldownManager, CooldownProps } from './manager';

declare module 'seyfert' {
	interface Client<Ready extends boolean = boolean> {
		cooldown?: CooldownManager;
	}

	interface HttpClient {
		cooldown?: CooldownManager;
	}

	interface WorkerClient<Ready extends boolean = boolean> {
		cooldown?: CooldownManager;
	}

	interface ExtendContext {
		cooldown?: CooldownManager;
	}

	interface UsingClient {
		cooldown?: CooldownManager;
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
