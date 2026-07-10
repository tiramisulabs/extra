import { createWorldDefaultContext, type WorldDefaultHooks } from './default-context';
import { registerCoreWorldRoutes } from './default-core-routes';
import { registerWorldResourceRoutes } from './default-resource-routes';
import type { MockApiHandler } from './rest';
import type { MockWorld } from './world';

export function registerWorldDefaults(
	rest: MockApiHandler,
	world: MockWorld | undefined,
	hooks: WorldDefaultHooks,
): void {
	const context = createWorldDefaultContext(rest, world, hooks);
	registerCoreWorldRoutes(context);
	registerWorldResourceRoutes(context);
}
