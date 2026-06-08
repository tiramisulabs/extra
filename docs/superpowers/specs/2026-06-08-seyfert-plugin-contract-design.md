# Seyfert Plugin Contract Design

Date: 2026-06-08

## Goal

Define the next Seyfert plugin contract before implementing core changes in the Seyfert core repository.

This design supersedes the narrower guide-first contract assumptions in `2026-06-08-seyfert-plugin-guide-design.md`. The guide remains useful for documentation work, but the core contract now needs to support a real third-party ecosystem: plugins should be installable integration units that declare capabilities through public extension points, without forcing authors to replace Seyfert internals such as `HandleCommand`.

## Inputs

- Existing Seyfert core spike for root-importable plugin authoring types and helpers.
- Plugin system review document provided during the design session.
- External pattern review: Nest modules/lifecycle, Fastify plugins, Hapi plugins, Vite/Astro integrations, and webpack hooks.
- Real ecosystem pressure from packages such as `yunaforseyfert`, which currently extends `HandleCommand` and imports from `seyfert/lib/...` to customize text command parsing and resolution.

## Definition

A Seyfert plugin is an installable integration object that contributes behavior, configuration, resources, or framework extensions to a Seyfert client through Seyfert's public plugin contract.

Practical taxonomy:

- Plugin: installed in `new Client({ plugins: [...] })` and composed/controlled by Seyfert.
- Adapter: replaces a lower-level infrastructure interface such as cache, HTTP, REST, or gateway behavior. It can be packaged by a plugin, but the adapter itself is not the main plugin contract.
- Utility: exported functions/classes the user imports and calls manually. It can support a plugin, but it is not a plugin by itself.

## Public Contract

```ts
export enum PluginEnforce {
	Pre = 'pre',
	Post = 'post',
}

export interface SeyfertPlugin<
	TOptions extends BaseClientOptions = BaseClientOptions,
	TClient extends UsingClient = UsingClient,
> {
	name: string;
	imports?: readonly SeyfertPlugin[];
	dependsOn?: readonly string[];
	enforce?: PluginEnforce;

	options?(): SeyfertPluginOptions<TOptions>;
	register?(api: SeyfertPluginApi): void;
	validate?(options: Readonly<BaseClientOptions>, api: SeyfertPluginValidationApi): void;

	setup?(client: SeyfertPluginClient<TClient>): Awaitable<void>;
	commandsLoaded?(client: SeyfertPluginClient<TClient>): Awaitable<void>;
	componentsLoaded?(client: SeyfertPluginClient<TClient>): Awaitable<void>;
	ready?(client: SeyfertPluginClient<TClient>): Awaitable<void>;
	teardown?(client: SeyfertPluginClient<TClient>): Awaitable<void>;
}
```

`createPlugin(...)` remains the public helper. Do not introduce `definePlugin` in this design. `setup` and `teardown` remain the lifecycle names; do not rename them to `onStart` or `onStop`.

`options()` has no arguments. The previous `current` snapshot is removed because it was a raw merge snapshot, not the final composed options. Plugins that need to inspect final state use `validate(...)`; plugins that need to register capabilities use `register(api)`.

## Plugin API

`register(api)` is a synchronous construction phase. It declares capabilities into an internal registry; it must not mutate handlers directly and must not depend on live runtime state.

Initial `SeyfertPluginApi`:

```ts
interface SeyfertPluginApi {
	commands: {
		add(...commands: SeteableCommand[]): void;
		text: {
			setArgsParser(parser: TextCommandArgsParser): void;
			setResolver(resolver: TextCommandResolver): void;
		};
	};

	components: {
		add(...components: SeteableComponent[]): void;
	};

	events: {
		add(...events: ClientEvent[]): void;
	};

	gateway: {
		addIntents(...intents: PluginIntentResolvable[]): void;
	};

	middlewares: {
		add(name: string, middleware: MiddlewareContext): void;
		useGlobal(name: string): void;
	};

	client: {
		decorate<K extends string>(key: K, factory: PluginServiceFactory): void;
	};

	services: {
		expose<K extends string>(key: K, factory: PluginServiceFactory): void;
	};
}
```

The exact type aliases can use Seyfert's existing internal names where available, but all public authoring types must be root-importable from `seyfert`. Do not require `seyfert/lib/...` imports for plugin authors.

## Registry Semantics

`register(api)` accumulates contributions in a registry. Seyfert applies those contributions at the correct runtime phase.

Additive extension points:

- `commands.add`
- `components.add`
- `events.add`
- `gateway.addIntents`
- `middlewares.add`
- `middlewares.useGlobal`

Singleton extension points:

- `commands.text.setArgsParser`
- `commands.text.setResolver`
- `client.decorate(key)`
- `services.expose(key)`

Singleton conflicts are errors by default. Do not add `override` in the first implementation unless a concrete plugin needs it.

## Plugin Resolution

Resolution rules:

1. Start from the user's `plugins` array.
2. Recursively expand each plugin's `imports` before the importing plugin.
3. Dedupe the same plugin object/instance.
4. Error if two different plugin instances share the same `name`.
5. Build hard order edges from `imports` and `dependsOn`.
6. Sort by hard dependencies.
7. Use `PluginEnforce.Pre` and `PluginEnforce.Post` as soft ordering preferences.
8. Preserve user array order as the tie-breaker.

`imports` and `dependsOn` are hard dependencies and win over `enforce`. `enforce` is a phase preference, not a dependency.

`imports` means "this plugin brings another plugin with it." `dependsOn` means "this plugin requires another plugin to exist, but it does not instantiate it."

Examples:

```ts
export function economyPlugin(options: { storage?: SeyfertPlugin } = {}) {
	return createPlugin({
		name: 'economy',
		imports: [options.storage ?? sqliteStoragePlugin()],
		register(api) {
			api.client.decorate('economy', client => new EconomyApi(client));
		},
	});
}
```

```ts
createPlugin({
	name: 'audit',
	dependsOn: ['database'],
});
```

If multiple plugins need the same imported plugin instance, the user or parent plugin should share that instance. Different instances with the same `name` are a conflict, not an implicit merge.

## Services And Decoration

Seyfert should expose a core runtime service registry:

```ts
ctx.client.services.get('economy');
ctx.client.services.getOptional('economy');
ctx.client.services.has('economy');
```

Typing uses module augmentation:

```ts
declare module 'seyfert' {
	interface RegisteredPluginServices {
		economy: EconomyApi;
	}
}
```

`services.get('economy')` returns `EconomyApi` without requiring a generic. Generic overloads can remain as escape hatches for dynamic keys.

`api.client.decorate('economy', factory)` does two things:

1. Adds `client.economy`.
2. Exposes the same value as `client.services.get('economy')`.

`api.services.expose('internal:scheduler', factory)` exposes a service without decorating the client.

Factories are registered during `register(api)` but instantiated before `setup()`, when a real client exists. Factories are synchronous. If a service needs async connection work, expose an object synchronously and connect it during `setup()`.

## Commands And Components

`api.commands.add(...)` and `api.components.add(...)` are declarative. They do not call `client.commands.set(...)` or `client.components.set(...)` during `register`.

Runtime application:

- Load disk commands first.
- Apply plugin commands after disk commands.
- Run `commandsLoaded`.
- Load disk components first.
- Apply plugin components after disk components.
- Run `componentsLoaded`.

Plugin commands/components must work even when there is no commands/components directory configured.

Any collision between plugin contributions or between plugin and disk contributions is an error in v1. Do not allow silent last-wins behavior.

This directly fixes the command-wipe failure mode where registering commands in `setup()` is erased by `CommandHandler.load()`.

## Text Command Pipeline

Plugins can customize text command parsing/resolution without extending `HandleCommand`.

```ts
register(api) {
	api.commands.text.setArgsParser(yunaArgsParser);
	api.commands.text.setResolver(yunaResolver);
}
```

Use context-object signatures:

```ts
export type TextCommandArgsParser = (context: TextCommandArgsParserContext) => Record<string, string>;

export interface TextCommandArgsParserContext {
	client: UsingClient;
	content: string;
	command: Command | SubCommand;
	message: MessageStructure;
}

export type TextCommandResolver = (
	context: TextCommandResolverContext,
) => CommandFromContent & { argsContent?: string };

export interface TextCommandResolverContext {
	client: UsingClient;
	content: string;
	prefix: string;
	rawMessage: GatewayMessageCreateDispatchData;
}
```

Yuna can adapt its current `this: HandleCommand` functions with a small wrapper. The public Seyfert contract should not expose or require subclassing `HandleCommand`.

Public root exports needed:

- `TextCommandArgsParser`
- `TextCommandArgsParserContext`
- `TextCommandResolver`
- `TextCommandResolverContext`
- `CommandFromContent`
- `CommandOptionWithType`

## Events

`api.events.add(...)` registers multi-listener events.

Events are notifications, not a pipeline. All listeners for a given event should be isolated and can run via `Promise.allSettled`. A failure in one plugin's listener must not prevent the user event or another plugin event from running.

Errors are reported with plugin/event attribution. Event listener failures do not throw to the gateway caller.

## Intents

`api.gateway.addIntents(...)` contributes gateway intents. Accept the same ergonomic input forms already supported by runtime config where practical: intent strings, numbers, and arrays.

Plugin intents are always OR-merged with user/config intents. A plugin intent is a minimum requirement for that plugin to function. If a user does not want that intent, they should not install the plugin or should disable that plugin feature through plugin-specific options.

For `WorkerClient`, plugin intents must be included before creating workers, not inside a worker after the manager already chose intents.

`HttpClient` can accept plugin intents as no-op contributions.

## Middlewares

`api.middlewares.add(name, middleware)` registers a middleware implementation.

`api.middlewares.useGlobal(name)` contributes that middleware name to `globalMiddlewares` with the same plugin-first/user-last composition as existing options.

Typing still uses `RegisteredMiddlewares` module augmentation:

```ts
declare module 'seyfert' {
	interface RegisteredMiddlewares {
		cooldown: typeof cooldownMiddleware;
	}
}
```

Name collisions are errors.

## Lifecycle Timing

Construction:

1. Resolve plugins, imports, names, dependencies, and order.
2. Run `options()` for each plugin.
3. Run `register(api)` for each plugin.
4. Merge and compose final client options.
5. Validate registry conflicts.
6. Run `validate(finalOptions, validationApi)`.

Start:

1. Set token and REST debug flags.
2. Instantiate services and decorations.
3. Run `setup`.
4. Start cache adapter.
5. Load languages.
6. Load disk commands.
7. Apply plugin commands.
8. Run `commandsLoaded`.
9. Load disk components.
10. Apply plugin components.
11. Run `componentsLoaded`.
12. Start gateway or HTTP runtime.
13. Run `ready`.

Close:

1. Run `teardown` in reverse plugin order.
2. Keep `close()` idempotent.

Idempotency:

- `setup`, `commandsLoaded`, `componentsLoaded`, and `ready` run once per start cycle.
- Calling `start()` twice without `close()` must not duplicate these hooks.
- After `close()`, a later `start()` may run them again.

Client variants:

- `Client`: `ready` runs when the client is actually ready and `client.me`/`applicationId` exist.
- `WorkerClient`: `ready` runs once per worker client instance. Avoid double-running on both `WORKER_READY` and manager-level `BOT_READY`.
- `HttpClient`: `ready` runs at the end of `start()` because there is no gateway ready event.

## Validation

`validate(finalOptions, api)` is synchronous and runs after `register` and conflict validation. It can inspect final options and registry state but cannot mutate them.

Validation API:

```ts
interface SeyfertPluginValidationApi {
	plugin: SeyfertPlugin;
	plugins: {
		has(name: string): boolean;
		names(): readonly string[];
	};
	services: {
		has<K extends keyof RegisteredPluginServices>(key: K): boolean;
		has(key: string): boolean;
	};
	fail(message: string): never;
	warn(message: string): void;
}
```

`fail` throws an attributed plugin error during client construction.

## Error Policy

All plugin failures should be attributed by plugin name, phase, and index/order where possible.

Phases:

- `options`
- `register`
- `validate`
- service/decorate factory
- `setup`
- `commandsLoaded`
- `componentsLoaded`
- `ready`
- `teardown`
- event listener

Errors should preserve the original error in `cause`.

Constructor-phase errors fail `new Client()`. Start-phase errors fail `start()` and should clean up completed setup work. Teardown errors are collected and surfaced as an `AggregateError`. Event errors are reported individually and do not stop other listeners.

## Out Of Scope

- Full plugin version negotiation.
- Semver constraints.
- `conflictsWith`.
- Fastify/Nest-style encapsulation scopes.
- Numeric plugin priority.
- Silent override/last-wins behavior.
- Requiring authors to subclass `HandleCommand`.
- Requiring plugin authors to import from `seyfert/lib/...`.
- Renaming `setup`/`teardown`.

## Implementation Slices

Recommended order for later implementation in the Seyfert core repository:

1. Plugin resolution: `imports`, unique names, `dependsOn`, `PluginEnforce`, deterministic order.
2. `register(api)` and internal registry with conflict detection.
3. Service registry and `client.services`; `client.decorate` applying before `setup`.
4. Declarative commands/components and loaded lifecycle hooks.
5. Text command parser/resolver registry and public root types.
6. Event multi-listeners with isolation.
7. Gateway intents OR-merge, including worker manager path.
8. Middleware registration.
9. `ready` lifecycle across `Client`, `WorkerClient`, and `HttpClient`.
10. Uniform attributed plugin errors and validation API.

Each slice should get consumer-facing type tests and focused runtime tests before implementation.

## Open Follow-Up

Decide whether a plugin preset should be allowed to hide imported plugin names from `client.plugins`, or whether `client.plugins` should always expose the fully expanded resolved list. Recommendation for implementation: expose the resolved list for debuggability.
