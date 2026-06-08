# Seyfert Plugin Guide Design

Date: 2026-06-08

## Goal

Create a documentation guide that answers the question: "How do I make a Seyfert plugin?"

The guide itself will live in `/Users/socram/dev/seyfert-web`, but this design stays in the `extra` workspace so the ecosystem context remains next to the Slipher package work.

The guide should make `SeyfertPlugin` the primary mental model for third-party authors. Adapters and utilities should be documented as related ecosystem categories, not as the main plugin contract.

## Approved Approach

Use approach A: guide first, with a small contract-polish watchlist.

Do not build a starter template yet. Do not start by changing Seyfert core. If the guide exposes awkward public types or forces deep imports, capture that as follow-up work for a possible approach C in `seyfert`.

## Target Files

In `seyfert-web`:

- Add `content/guide/recipes/plugins.mdx`
- Update `content/guide/recipes/meta.json` to include `plugins`
- Update `content/guide/tips/ecosystem.mdx` to link to the guide and clarify package categories

Do not put the final user-facing guide in `extra`.

## Navigation Design

Add one recipe page:

- Path: `/guide/recipes/plugins`
- Title: `Creating Plugins`

Keep `content/guide/tips/ecosystem.mdx` as the package catalog and taxonomy page. It should link to the recipe for people who want to author a plugin.

## Guide Outline

### 1. What a Seyfert plugin is

Define a plugin as a `SeyfertPlugin` object passed to:

```ts
new Client({
  plugins: [loggerPlugin()],
});
```

Explain that a plugin can contribute:

- client option fragments through `options()`
- context fields through `options.context`
- scoped execution through `contextScopes`
- defaults/hooks for commands, components, and modals
- setup and teardown lifecycle

### 2. Minimal logger plugin

Use a simplified logger based on `tiramisulabs/extra#18`, not the full `@slipher/logger` package.

The example should teach Seyfert integration, not production-grade logging. It should show:

- a `loggerPlugin(options)` factory
- `satisfies SeyfertPlugin` or a return type of `SeyfertPlugin`
- `options.context` adding `ctx.logger`
- `declare module "seyfert"` extending `ExtendContext`

### 3. Scope with `contextScopes`

Explain the difference between `context` and `contextScopes`:

- `context` answers "how does `ctx.logger` appear?"
- `contextScopes` answers "how can deep helpers use the current logger without receiving `ctx`?"

Show a minimal `AsyncLocalStorage` based `useLogger()` example. Keep it small and focused on the contract.

### 4. Lifecycle

Explain:

- `setup(client)` initializes plugin resources during `client.start()`
- `teardown(client)` flushes or closes resources through `client.close()`
- setup is for runtime wiring, not type augmentation

Show setup/teardown on the simplified logger:

```ts
setup(client) {
  root.info("logger plugin ready");
}

teardown() {
  return root.flush();
}
```

### 5. Packaging minimum

Include only the package metadata needed for correct third-party ergonomics:

- `seyfert` should be a peer dependency to avoid duplicate installs and broken module augmentation
- `seyfert` can also be a dev dependency for local tests/builds
- define an `exports` map for the root package entry

Example:

```json
{
  "name": "seyfert-plugin-example",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "peerDependencies": {
    "seyfert": ">=4.3.0-0"
  },
  "devDependencies": {
    "seyfert": ">=4.3.0-0",
    "typescript": "^5.9.3"
  }
}
```

This is not a publishing guide. Avoid npm release flow, versioning strategy, CI, badges, or package-template details.

### 6. What is not a plugin

Add a short taxonomy:

- `SeyfertPlugin`: adds behavior to the client, context, defaults, or lifecycle
- Adapter: replaces infrastructure like cache, HTTP, REST, or gateway behavior
- Utility: exports functions/classes consumed manually

Adapters can appear at the end as related extension points, but they should not be the main answer to "how do I make a plugin?"

## Example Boundaries

Include:

- `LoggerPluginOptions`
- minimal `SimpleLogger`
- `loggerPlugin()`
- `ctx.logger`
- `useLogger()`
- `contextScopes`
- `onAfterRun`
- `onRunError`
- `setup`
- `teardown`
- `declare module "seyfert"` for `ExtendContext`

Exclude:

- Pino adapter
- evlog adapter
- wide-event theory
- intercepting Seyfert internals
- console formatting
- full tests
- npm publishing flow
- cache resources
- decorators
- middleware examples

Mention that the real `@slipher/logger` can be more complete, but the guide intentionally stays smaller.

## Contract Polish Watchlist

While writing the guide, verify whether plugin authors can use only root `seyfert` imports.

Known current state from local inspection:

- `SeyfertPlugin` is exported through `seyfert`
- `SeyfertPluginClient` is exported through `seyfert`
- `ContextScope` appears available through client exports, but verify from consumer snippets
- `SeyfertPlugin.options()` currently returns an internal fragment type, so helper authors may need to repeat the shape unless Seyfert exports a public fragment type

Potential follow-up in `seyfert`:

- export a public `SeyfertPluginOptionsFragment` or equivalent name
- make `ContextScope` clearly root-importable in docs
- avoid recommending `seyfert/lib/...` imports for plugin authoring

Do not change runtime behavior unless writing the guide reveals a real limitation.

## Source Evidence

Local repo inspection found:

- `seyfert` core already has `SeyfertPlugin` with `options`, `setup`, and `teardown`
- plugin setup runs during `client.start()`
- plugin teardown runs through `client.close()`
- `context`, `contextScopes`, `globalMiddlewares`, and command/component/modal defaults compose in plugin order before user hooks
- `extra#18` provides the real logger plugin reference, but the docs example should be smaller

## Success Criteria

The final guide should let a third-party author answer:

1. What object do I export?
2. How does the user install it on `new Client({ plugins })`?
3. How do I add `ctx.something`?
4. How do I keep request-scoped state across helper calls?
5. Where do setup and cleanup belong?
6. What package metadata prevents duplicate Seyfert installs?
7. When am I building an adapter or utility instead of a plugin?

## Out of Scope

- Implementing the final guide in this design step
- Creating a starter package
- Updating `extra` package READMEs
- Publishing anything
- Changing `@slipher/logger`
- Changing `seyfert` core before the guide identifies a concrete contract gap
