# seyfert/options-use-builders

Every value inside a seyfert `@Options({ ... })` must be produced by a `createXOption` builder (`createStringOption`, `createIntegerOption`, …). A raw object is not a valid option for seyfert.

Type-aware: the builder must come from seyfert and **only** seyfert (a local `createStringOption` is rejected). The record is resolved through the TypeScript program, so it follows `const` bindings, `satisfies`/`as const`, spreads, and records imported from other files. The array form `@Options([Sub, ...])` (subcommands) is left alone.

## ✅ Valid

```ts
@Options({ query: createStringOption({ description: 'Search query' }) })

const opts = { query: createStringOption({ description: 'Search query' }) };
@Options(opts) // resolved through the variable
```

## ❌ Invalid

```ts
@Options({ query: { description: 'Search query' } }) // not a builder call
```

## Notes

Records built dynamically (`@Options(makeOpts())`, computed objects) are skipped — TypeScript's `OptionsRecord` type still backstops the shape.
