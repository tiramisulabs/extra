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

## Usage

These rules need type information, so the consumer must enable the
typescript-eslint parser with a project service:

```js
// eslint.config.mjs
import tseslint from 'typescript-eslint';
import seyfert from '@slipher/eslint-plugin';

export default tseslint.config(
	{ languageOptions: { parserOptions: { projectService: true } } },
	...seyfert.configs.recommended,
);
```

Or wire individual rules:

```js
{
	plugins: { seyfert },
	rules: { 'seyfert/require-declare': 'error' },
}
```
