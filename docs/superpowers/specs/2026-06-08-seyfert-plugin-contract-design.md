# Seyfert Plugin Contract - Implementation Snapshot

Date: 2026-06-09

## Status

This document now describes the plugin API implemented for the Seyfert v5 core
work. It intentionally supersedes the broader proposal notes that included
`dependsOn`, `PluginEnforce`, `client.services`, `api.client.decorate`,
interaction interceptors, text parser hooks, gateway intents, service slots, and
unsafe patches.

Those ideas can still be revisited later, but they are not part of the current
contract and should not be documented as shipped.

## Goal

Give third-party package authors a stable, root-importable contract for building
Seyfert plugins without importing from `seyfert/lib/...` or replacing internal
handlers such as `HandleCommand`.

A plugin should be able to answer:

1. What does my package add to Seyfert?
2. How does the user install it on `new Client({ plugins })`?
3. What gets exposed on `client.*` or `ctx.*`?
4. What work belongs in `register`, `setup`, and `teardown`?
5. How are errors and conflicts attributed?

## Definition

A Seyfert plugin is an installable integration object that contributes behavior,
configuration, resources, or framework extensions to a Seyfert client through
Seyfert's public plugin contract.

Practical taxonomy:

- Plugin: installed in `new Client({ plugins: [...] })` and composed by Seyfert.
- Adapter: replaces a lower-level infrastructure interface such as cache, HTTP,
  REST, or gateway behavior. An adapter can be used by a plugin, but the adapter
  itself is not the plugin contract.
- Utility: exported functions/classes the user imports and calls manually. It can
  support a plugin, but it is not a plugin by itself.

## Implemented Public Contract

The public authoring helper is `createPlugin(...)`. It is an identity helper that
preserves inference and should be used in documentation examples.

```ts
import { createPlugin } from 'seyfert';

export const examplePlugin = createPlugin({
	name: 'example',
	client: {
		example: client => new ExampleService(client),
	},
	ctx: {
		example: (interaction, client) => new ExampleContextHelper(interaction, client),
	},
	register(api) {
		api.commands.add(ExampleCommand);
		api.components.add(ExampleButton);
		api.modals.add(ExampleModal);
		api.events.on('botReady', client => {
			client.logger.info('example plugin ready');
		});
		api.middlewares.add('example-audit', exampleMiddleware, { global: true });
		api.options.set({ allowedMentions: { parse: [] } });
	},
	async setup(client) {
		await client.example.start();
	},
	async teardown(client) {
		await client.example.stop();
	},
});
```

The implemented shape is:

```ts
export interface SeyfertPlugin<
	E extends object = {},
	C extends object = {},
	I extends readonly AnySeyfertPlugin[] = readonly [],
> {
	name: string;
	imports?: I;
	client?: PluginClientMap<E>;
	ctx?: PluginContextMap<C>;
	register?(api: SeyfertPluginApi): void;
	setup?(client: SeyfertPluginClient & ExtendOf<I> & E): Awaitable<void>;
	teardown?(client: SeyfertPluginClient & ExtendOf<I> & E): Awaitable<void>;
}
```

`client` and `ctx` are static key maps. This is intentional: Seyfert can inspect
the keys before runtime, detect collisions, and provide stable type inference.

Factories receive `BaseClient`, not the fully augmented `UsingClient`, to avoid a
type cycle. A plugin's own `setup` receives its own client extension and the
extensions from its `imports`.

## Implemented Plugin API

`register(api)` is synchronous. It declares behavior into an internal registry.
It must not await runtime work and must not directly mutate handlers.

```ts
interface SeyfertPluginApi {
	events: {
		on<E extends ClientNameEvents | CustomEventsKeys | GatewayEvents>(
			name: E,
			handler: (...args: ResolveEventParams<E>) => unknown,
			opts?: { once?: boolean },
		): void;
		onAny(handler: (name: string, ...args: unknown[]) => unknown): void;
		emit<E extends CustomEventsKeys>(name: E, ...payload: ResolveEventRunParams<E>): void;
	};
	commands: {
		add(...commands: HandleableCommand[]): void;
	};
	components: {
		add(...components: HandleableComponent[]): void;
	};
	modals: {
		add(...modals: HandleableModal[]): void;
	};
	middlewares: {
		add(name: string, middleware: MiddlewareContext, opts?: { global?: boolean }): void;
	};
	options: {
		set(fragment: SeyfertPluginOptions): void;
	};
}
```

Current extension strategies:

| API | Strategy | Conflict behavior |
| --- | --- | --- |
| `commands.add` | Additive | Duplicate command names fail |
| `components.add` | Additive | Duplicate static `customId` values fail |
| `modals.add` | Additive | Duplicate static `customId` values fail |
| `events.on` | Additive | Multiple listeners are allowed |
| `events.onAny` | Additive | Multiple listeners are allowed |
| `events.emit` | Notification | Gateway event names cannot be emitted |
| `middlewares.add` | Additive by name | Duplicate name policy follows middleware registration |
| `options.set` | Composed fragment | Merged before user options |

## Resolution Rules

Implemented resolution:

1. Start from the user's `plugins` array.
2. Recursively expand each plugin's `imports` before the importing plugin.
3. Dedupe the same plugin object/instance.
4. Error if two different plugin instances share the same `name`.
5. Preserve resolved order from imports plus user array order.

Not implemented yet:

- `dependsOn`
- `PluginEnforce`
- numeric priority
- plugin semver negotiation
- `conflictsWith`

If multiple plugins need the same imported plugin, the user or parent plugin
should share that plugin instance. Different instances with the same `name` are
a conflict, not an implicit merge.

## Client And Context Extension

`client` adds app-wide client properties:

```ts
const queuesPlugin = createPlugin({
	name: '@slipher/queues',
	client: {
		queues: () => registry,
	},
});
```

`ctx` adds per-interaction context properties:

```ts
const loggerPlugin = createPlugin({
	name: '@slipher/logger',
	ctx: {
		logger: () => createWideEventLogger(),
	},
});
```

Rules:

- Static `client` and `ctx` keys are collected during construction.
- Duplicate plugin `client` keys fail.
- Duplicate plugin `ctx` keys fail.
- `client` keys cannot overwrite existing client properties.
- `client` factories are synchronous and run before `setup`.
- `ctx` factories run when Seyfert builds an interaction context.

For cross-file types, applications use `Register`:

```ts
const loggerPlugin = logger();
const cooldownPlugin = cooldown();

declare module 'seyfert' {
	interface Register {
		plugins: [typeof loggerPlugin, typeof cooldownPlugin];
	}
}
```

`Register` is the source of global app typing. `imports` helps the importing
plugin internally, but imported plugin types do not become global app types
unless they are included in `Register`.

## Lifecycle Timing

Construction:

1. Resolve plugin order and imports.
2. Collect static `client` and `ctx` keys.
3. Create context fragments from `ctx`.
4. Run legacy `options(current)` if present for compatibility.
5. Run `register(api)`.
6. Merge plugin option fragments before user options.
7. Compose contexts, context scopes, global middlewares, and default hooks.

Start:

1. Resolve token and REST debug flags.
2. Ensure `handleCommand` exists.
3. Install and run plugin setup.
4. Start cache adapter.
5. Load languages.
6. Load disk commands.
7. Apply plugin commands.
8. Emit `commandsLoaded`.
9. Load disk components.
10. Apply plugin components and modals.
11. Emit `componentsLoaded`.

Close:

1. `client.close()` waits for in-flight plugin setup.
2. Runs `teardown` in reverse plugin order.
3. Clears setup/close promises after completion.

`setup` should start resources. `teardown` should flush, close, or restore them.
Do not create new typed client keys in `setup`; declare them in `client`.

## Commands, Components, And Modals

Plugin command/component/modal registration is declarative:

```ts
register(api) {
	api.commands.add(PingCommand);
	api.components.add(RefreshButton);
	api.modals.add(ProfileModal);
}
```

Runtime application:

- Disk commands load first.
- Plugin commands are applied after disk commands.
- `commandsLoaded` is emitted after plugin commands are applied.
- Disk components load first.
- Plugin components and modals are applied after disk components.
- `componentsLoaded` is emitted after plugin components and modals are applied.

Conflicts are errors. Seyfert does not allow silent last-wins behavior here.
Subcommands cannot be registered as top-level plugin commands.

This fixes the old failure mode where registering commands in `setup()` could be
erased by later command loading.

## Events

Plugins can listen to gateway, client, and custom events:

```ts
register(api) {
	api.events.on('botReady', client => {
		client.logger.info('ready');
	});

	api.events.on('commandsLoaded', (commands, client) => {
		client.logger.info({ count: commands.length }, 'commands loaded');
	});
}
```

Events are notifications, not a pipeline. Multiple plugin listeners can observe
the same event. Listener tasks are isolated and settled together, so one plugin
failure is attributed without skipping the remaining listeners.

Plugins can emit custom events with `api.events.emit(...)`. Emitting gateway event
names is rejected.

Implemented custom lifecycle events:

- `commandsLoaded`
- `componentsLoaded`

## Diagnostics And Errors

`client.plugins` is the resolved plugin list. It also exposes:

- `client.plugins.resolved`
- `client.plugins.diagnostics`

Diagnostics include plugin name, order index, imports, client keys, context keys,
command/component/modal contribution counts, events, and middlewares.

Plugin errors should preserve the original error in `cause` and identify:

- plugin name
- phase
- resolved index

Current attributed phases include `register`, `options`, `client.<key>`,
`ctx.<key>`, `commands.add`, `components.add`, `setup`, `teardown`, and event
listener failures.

## Package Authoring Defaults

Third-party plugin packages should:

- Export the public plugin factory from the package root.
- Use `createPlugin(...)` in the implementation.
- Put `seyfert` in `peerDependencies` with a v5-compatible range.
- Put `seyfert` in `devDependencies` for local tests and type checks.
- Publish only supported entry points through `exports`.
- Avoid `seyfert/lib/...` imports in public examples.
- Keep adapters as adapters unless they also expose a Seyfert plugin.

Minimal metadata:

```json
{
	"name": "seyfert-plugin-example",
	"type": "module",
	"exports": {
		".": {
			"types": "./lib/index.d.ts",
			"import": "./lib/index.js",
			"require": "./lib/index.js",
			"default": "./lib/index.js"
		},
		"./package.json": "./package.json"
	},
	"peerDependencies": {
		"seyfert": ">=5.0.0-0"
	},
	"devDependencies": {
		"seyfert": ">=5.0.0-0"
	}
}
```

## Extra Package Migration Notes

The current `extra` plugin migrations should be used as practical examples:

- `@slipher/logger`: exposes request logging through `ctx.logger`; keeps
  `client.logger` as Seyfert's native logger; teardown restores installed hooks.
- `@slipher/queues`: exposes one registry through `client.queues`, `ctx.queues`,
  and the plugin factory return value; teardown closes registry access.
- `@slipher/scheduler`: exposes one registry through `client.scheduler`,
  `ctx.scheduler`, and the plugin factory return value; immediate memory tasks
  are deferred until plugin setup.
- `@slipher/cooldown`: exposes `client.cooldown` and `ctx.cooldown`; cache miss
  normalization belongs in Seyfert `BaseResource`, not in the cooldown package.

## Do Not Document As Shipped Yet

These belong to future design work unless a later PR implements them:

- `dependsOn`
- `PluginEnforce`
- `validate`
- `client.services`
- `api.client.decorate`
- `api.services.expose`, `claim`, or `wrap`
- `api.interaction.around`, `onRun`, `onAfterRun`, `onError`, `onDeny`
- text command parser/resolver registration
- command/component/modal factories or `onLoad`
- gateway intent contributions
- REST interceptors
- cache resource registration
- language registration
- transformers
- `ready` plugin lifecycle
- `unsafe.patch`

## Documentation Handoff

The first public guide should focus on the implemented v5 MVP:

1. Define plugin vs adapter vs utility.
2. Create a minimal plugin with `createPlugin`.
3. Add `client.*` and `ctx.*` using static maps.
4. Register commands, components, modals, middlewares, and events.
5. Explain `setup`, `teardown`, and `client.close()`.
6. Show `Register` augmentation for cross-file types.
7. Explain `imports` ordering.
8. Show package `peerDependencies` and `exports`.
9. Mention diagnostics and attributed errors.

Avoid documenting proposal-only APIs until they are implemented.
