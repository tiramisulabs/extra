# @slipher/eslint-plugin

Type-aware ESLint rules for Seyfert commands, decorators, options, middleware, configuration, and interactions.

**[Read the complete ESLint guide on seyfert.dev](https://seyfert.dev/docs/recipes/eslint).**

## Install

```sh
pnpm add -D @slipher/eslint-plugin eslint typescript-eslint
```

Requires ESLint 9, TypeScript 5, and Seyfert 5 or newer.

## Quick start

```js
import tseslint from 'typescript-eslint';
import { configs as seyfert } from '@slipher/eslint-plugin';

export default tseslint.config(
	{ languageOptions: { parserOptions: { projectService: true } } },
	...seyfert.recommended,
);
```

Use the named `configs` export. The package is CommonJS, so a default import does not expose the recommended configuration directly under ESM interop.
