# Seyfert Plugin Guide Handoff

Date: 2026-06-09

## Goal

Create a public documentation guide that answers:

> How do I make a Seyfert plugin?

The final user-facing guide belongs in the Seyfert website docs. This handoff
stays in `extra` because the practical examples come from the Slipher package
migrations.

Use `SeyfertPlugin` and `createPlugin` as the main mental model. Adapters and
utilities should be documented as related ecosystem categories, not as the main
answer.

## Current Contract To Document

Document only the implemented v5 plugin MVP:

- `createPlugin(...)`
- `name`
- `imports`
- `client`
- `ctx`
- `register(api)`
- `setup(client)`
- `teardown(client)`
- `api.commands.add`
- `api.components.add`
- `api.modals.add`
- `api.events.on`
- `api.events.onAny`
- `api.events.emit`
- `api.middlewares.add`
- `api.options.set`
- `Register` augmentation
- `client.plugins.resolved`
- `client.plugins.diagnostics`
- `commandsLoaded`
- `componentsLoaded`

Do not document proposal-only APIs as shipped. In particular, do not include
`dependsOn`, `PluginEnforce`, `client.services`, `api.client.decorate`,
`interaction.around`, text command parser hooks, gateway intents, REST
interceptors, service slots, command factories, `onLoad`, `ready`, or
`unsafe.patch`.

## Target Navigation

Recommended website shape:

- Add a recipe page titled `Creating Plugins`.
- Keep the ecosystem/tips page as the package catalog and taxonomy page.
- Link from the ecosystem page to the plugin authoring recipe.

The guide should be practical. It should not read like an API reference dump.

## Guide Outline

### 1. What a Seyfert plugin is

Define a plugin as an object passed to:

```ts
new Client({
	plugins: [loggerPlugin],
});
```

Explain that a plugin can contribute:

- app-wide services through `client`
- interaction helpers through `ctx`
- commands, components, modals, events, middlewares, and option fragments through
  `register(api)`
- startup work through `setup`
- cleanup work through `teardown`

### 2. Minimal plugin

Use a tiny plugin first:

```ts
import { createPlugin } from 'seyfert';

export const pingPlugin = createPlugin({
	name: 'ping-plugin',
	register(api) {
		api.commands.add(PingCommand);
	},
});
```

Show installation:

```ts
import { Client } from 'seyfert';
import { pingPlugin } from './ping-plugin';

const client = new Client({
	plugins: [pingPlugin],
});
```

### 3. Client and context helpers

Use a simplified logger as the main teaching example. It should teach Seyfert
integration, not production-grade logging.

```ts
import { createPlugin } from 'seyfert';

export function loggerPlugin() {
	const root = new SimpleLogger();

	return createPlugin({
		name: 'example-logger',
		client: {
			exampleLogger: () => root,
		},
		ctx: {
			logger: interaction => root.child({
				interactionId: interaction.id,
			}),
		},
		setup(client) {
			client.exampleLogger.info('logger plugin ready');
		},
		teardown(client) {
			return client.exampleLogger.flush();
		},
	});
}
```

Explain the distinction:

- `client` is for app-wide, stable resources.
- `ctx` is for per-interaction helpers.
- Factories are synchronous.
- Async connection or cleanup belongs in `setup` and `teardown`.

### 4. Register augmentation

Show the app-level typing pattern:

```ts
const logger = loggerPlugin();

declare module 'seyfert' {
	interface Register {
		plugins: [typeof logger];
	}
}

const client = new Client({
	plugins: [logger],
});
```

Then show usage from a command:

```ts
export default class ProfileCommand extends Command {
	async run(ctx: CommandContext) {
		ctx.logger.info('profile opened');
		ctx.client.exampleLogger.info('root logger is available');
	}
}
```

Use `Register`, not `ExtendContext`, as the main plugin typing story.

### 5. Lifecycle

Explain:

- `register(api)` is synchronous and declarative.
- `setup(client)` runs during `client.start()` after plugin client properties
  exist and before command/component loading completes.
- `teardown(client)` runs through `client.close()` in reverse plugin order.
- `setup` starts resources; `teardown` flushes, closes, or restores them.

Mention that plugin commands and components are applied after disk-loaded ones,
then `commandsLoaded` and `componentsLoaded` are emitted.

### 6. Registering behavior

Show one compact example with multiple contribution types:

```ts
register(api) {
	api.commands.add(HealthCommand);
	api.components.add(RefreshButton);
	api.modals.add(ProfileModal);
	api.middlewares.add('audit', auditMiddleware, { global: true });

	api.events.on('commandsLoaded', (commands, client) => {
		client.logger.info({ count: commands.length }, 'commands loaded');
	});
}
```

Explain conflicts:

- duplicate command names fail
- duplicate static component/modal custom IDs fail
- duplicate `client` or `ctx` keys fail
- multiple event listeners are allowed

### 7. Imports and ordering

Explain `imports` as "this plugin brings another plugin with it":

```ts
const storage = storagePlugin();

export const economy = createPlugin({
	name: 'economy',
	imports: [storage],
	client: {
		economy: client => new EconomyService(client),
	},
});
```

Clarify:

- imported plugins resolve before the importing plugin
- the same plugin instance is deduped
- different instances with the same name are conflicts
- there is no shipped `dependsOn` or priority API yet

### 8. Package metadata

Include the minimum metadata needed for third-party ergonomics:

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
		"seyfert": ">=5.0.0-0",
		"typescript": "^5.9.3"
	}
}
```

This is not a publishing guide. Avoid npm release flow, versioning strategy, CI,
badges, and package-template details.

### 9. What is not a plugin

Add a short taxonomy:

- `SeyfertPlugin`: adds behavior to the client, context, lifecycle, or runtime
  registry.
- Adapter: swaps infrastructure such as cache, HTTP, REST, gateway, or storage.
- Utility: exports functions/classes consumed manually.

Adapters can appear at the end as related extension points, but they should not
be the main answer to "how do I make a plugin?"

## Example Boundaries

Include:

- `createPlugin`
- `LoggerPluginOptions`
- minimal `SimpleLogger`
- `loggerPlugin()`
- `client.exampleLogger`
- `ctx.logger`
- `Register`
- `commandsLoaded`
- `setup`
- `teardown`
- package `peerDependencies`
- package `exports`

Exclude:

- Pino adapter
- evlog adapter
- wide-event theory
- console formatting
- full tests
- npm publishing flow
- cache resources
- decorators
- `contextScopes` as the main plugin path
- `ExtendContext` as the main plugin typing path
- internal `seyfert/lib/...` imports

Mention that real packages such as `@slipher/logger`, `@slipher/queues`,
`@slipher/scheduler`, and `@slipher/cooldown` are more complete than the guide
example.

## Source Evidence

The current implementation provides:

- root `createPlugin`
- root `SeyfertPlugin`
- root `SeyfertPluginApi`
- root `SeyfertPluginClient`
- root `Register`
- static `client` and `ctx` maps
- `imports` resolution
- plugin diagnostics on `client.plugins`
- `register(api)` contributions for commands, components, modals, events,
  middlewares, and options
- `setup` and `teardown`
- `commandsLoaded` and `componentsLoaded`

The migrated `extra` packages provide practical examples:

- `@slipher/logger`: context logger lifecycle
- `@slipher/queues`: shared registry exposed on client and context
- `@slipher/scheduler`: setup-driven scheduler startup
- `@slipher/cooldown`: cache-backed manager exposed on client and context

## Success Criteria

The final guide should let a third-party author answer:

1. What object do I export?
2. How does the user install it on `new Client({ plugins })`?
3. How do I add `client.something`?
4. How do I add `ctx.something`?
5. Where do setup and cleanup belong?
6. How do I register commands, components, modals, events, or middlewares?
7. What package metadata prevents duplicate Seyfert installs?
8. When am I building an adapter or utility instead of a plugin?

## Out Of Scope

- Implementing the final website guide in this design step
- Creating a starter package
- Publishing anything
- Updating every `extra` package README
- Documenting proposal-only APIs as shipped
