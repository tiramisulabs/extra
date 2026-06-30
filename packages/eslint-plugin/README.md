# @slipher/eslint-plugin

Type-aware ESLint rules for [seyfert](https://seyfert.dev). Every rule resolves
symbols through the TypeScript type checker, so it only ever fires on seyfert's
own `Command`, `Declare`, `Options`, … — never a same-named symbol from another
package.

## Rules

| Rule | Description | Fixable |
| --- | --- | --- |
| `seyfert/require-declare` | Classes extending a seyfert command base must carry `@Declare`. | – |
| `seyfert/no-deep-imports` | Prefer the `seyfert` root over deep `seyfert/lib/...` paths when the symbol is re-exported from root. | ✅ |
| `seyfert/options-use-builders` | Values in `@Options({ ... })` must be created with a `createXOption` builder. | – |
| `seyfert/no-hanging-middleware` | `createMiddleware` callbacks must call `next()` or `stop()` on every code path. | – |
| `seyfert/decorator-target` | `@Group` only on a `SubCommand`; `@Groups`/`@GroupsT`/`@AutoLoad` only on a `Command`. | – |
| `seyfert/required-options-order` | Required options must be declared before optional ones (Discord rejects the reverse). | – |
| `seyfert/declare-description` | Command and option descriptions must be non-empty and at most 100 characters. | – |
| `seyfert/context-menu-declare` | A `ContextMenuCommand`'s `@Declare` must set `type` and must not set `description`. | – |
| `seyfert/autocomplete-respond` | Answer an autocomplete interaction with `.respond()`, never the internal `.reply()`. | – |
| `seyfert/decorator-on-command` | `@Declare`/`@Options`/`@Middlewares`/`@Locales`/`@LocalesT` only on a class extending a command base. | – |
| `seyfert/config-default-export` | The result of `config.bot()`/`config.http()` must be the file's `export default`. | – |
| `seyfert/i18n-resolve-with-get` | Resolve a `ctx.t` locale proxy with `.get()` before using it as a string. | – |
| `seyfert/group-exists` | A subcommand's `@Group` must reference a group declared in the command's `@Groups`/`@GroupsT` (resolves both `@Options` and `@AutoLoad`). | – |
| `seyfert/prefer-typed-group` | Prefer the type-safe `@Group(groups, name)` overload over a bare `@Group(name)`. **(opt-in — not in `recommended`)** | – |

> **Floating promises:** seyfert's response methods (`ctx.write`, `ctx.editOrReply`,
> `interaction.respond`, …) return promises. There is no seyfert-specific rule for
> this on purpose — enable [`@typescript-eslint/no-floating-promises`](https://typescript-eslint.io/rules/no-floating-promises/),
> which already covers them (and everything else) with full type information.

## Usage

These rules need type information, so the consumer must enable the
typescript-eslint parser with a project service:

```js
// eslint.config.mjs
import tseslint from 'typescript-eslint';
import { configs as seyfert } from '@slipher/eslint-plugin';

export default tseslint.config(
	{ languageOptions: { parserOptions: { projectService: true } } },
	...seyfert.recommended,
);
```

> It's a CommonJS package, so consume the **named** `configs` export (a default
> import yields the module namespace under ESM interop).

Or wire individual rules:

```js
import seyfert from '@slipher/eslint-plugin';

export default [
	{
		plugins: { seyfert },
		rules: { 'seyfert/require-declare': 'error' },
	},
];
```
