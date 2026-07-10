import {
	type AnyContext,
	createContextScope,
	createPlugin,
	Formatter,
	type MiddlewareContext,
	type PluginMiddlewareMap,
	type SeyfertPlugin,
} from 'seyfert';
import type { BaseClient } from 'seyfert/lib/client/base';
import { runWithCooldownContext } from './context';
import { CooldownManager, type CooldownResult } from './manager';

export type CooldownMiddlewareMessage = string | ((result: CooldownResult, context: AnyContext) => string);

export interface CooldownMiddlewareOptions {
	global?: boolean;
	message?: CooldownMiddlewareMessage;
	name?: string;
}

export type CooldownMiddleware = MiddlewareContext<CooldownResult | undefined, AnyContext>;
export type CooldownMiddlewares<Name extends string = 'cooldown'> = Record<Name, CooldownMiddleware>;

export interface CooldownPluginOptions {
	middleware?: boolean | CooldownMiddlewareOptions;
}

export type CooldownPluginMiddlewares<TOptions> = TOptions extends { middleware: true } ? CooldownMiddlewares : {};

export interface CooldownPlugin<TMiddlewares extends PluginMiddlewareMap = {}>
	extends SeyfertPlugin<{ cooldown: CooldownManager }, { cooldown: CooldownManager }, readonly [], TMiddlewares> {
	name: '@slipher/cooldown';
	manager: CooldownManager;
	setup(client: BaseClient): void;
}

export function cooldown<const TOptions extends CooldownPluginOptions = {}>(
	options: TOptions = {} as TOptions,
): CooldownPlugin<CooldownPluginMiddlewares<TOptions>> {
	const manager = new CooldownManager();
	const contextScope = createContextScope((context, run) => runWithCooldownContext(context as AnyContext, run));
	const middleware = resolveCooldownMiddleware(options.middleware, manager);

	return createPlugin({
		name: '@slipher/cooldown',
		manager,
		client: {
			cooldown: () => manager,
		},
		ctx: {
			cooldown: () => manager,
		},
		options() {
			return { contextScopes: [contextScope] };
		},
		register(api) {
			if (!middleware) return;
			const add = api.middlewares.add as (
				name: string,
				middleware: CooldownMiddleware,
				options?: { global?: boolean },
			) => void;
			add(middleware.name, middleware.run, middleware.global === undefined ? undefined : { global: middleware.global });
		},
		setup(client) {
			manager.attach(client);
		},
	}) as CooldownPlugin<CooldownPluginMiddlewares<TOptions>>;
}

function resolveCooldownMiddleware(input: CooldownPluginOptions['middleware'], manager: CooldownManager) {
	if (!input) return undefined;
	const options = input === true ? {} : input;
	return {
		global: options.global,
		name: options.name ?? 'cooldown',
		run: createCooldownMiddleware(manager, options),
	};
}

function createCooldownMiddleware(manager: CooldownManager, options: CooldownMiddlewareOptions): CooldownMiddleware {
	return async ({ context, next, stop }) => {
		const result = await manager.consume();
		if (!result || result.allowed) return next(result);
		return stop(resolveCooldownMiddlewareMessage(result, context, options.message));
	};
}

function resolveCooldownMiddlewareMessage(
	result: CooldownResult & { allowed: false },
	context: AnyContext,
	message?: CooldownMiddlewareMessage,
) {
	if (typeof message === 'function') return message(result, context);
	if (message) return message;
	return `This command is cooling down. Try again ${Formatter.timestamp(result.retryAfter)}.`;
}
