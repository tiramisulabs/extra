import { AsyncLocalStorage } from 'node:async_hooks';
import type { AnyContext } from 'seyfert';
import type { Awaitable } from 'seyfert/lib/common';

const cooldownContexts = new AsyncLocalStorage<AnyContext>();

export function runWithCooldownContext<T>(context: AnyContext, run: () => Awaitable<T>): Awaitable<T> {
	return cooldownContexts.run(context, run);
}

export function getCooldownContext(): AnyContext | undefined {
	return cooldownContexts.getStore();
}
