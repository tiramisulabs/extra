# seyfert/no-hanging-middleware

`createMiddleware(cb)` callbacks must call `next()` or `stop()` on **every** code path, or the command pipeline hangs forever.

Uses ESLint's control-flow (code-path) analysis, so every branch is covered: if/else, switch, early `return`, loops, async/await. `throw` paths are exempt. Constant conditions are folded **type-aware** — `if (true) { next(); }`, or any condition whose *type* is always-truthy (non-empty string literal, object, array, class, function, …), is not a false positive.

## ✅ Valid

```ts
createMiddleware(({ next, stop }) => {
  if (denied) return stop('Not allowed.');
  next();
});

createMiddleware(({ next }) => {
  if (true) { next(); } // constant-true, folded
});
```

## ❌ Invalid

```ts
createMiddleware(({ next }) => {
  if (allowed) next(); // the else path never advances → hangs
});
```

## Notes

Only inline `createMiddleware(cb)` callbacks are analysed; an advancer call inside a nested callback (`x.then(() => next())`) isn't recognized — use `async`/`await`. Constant folding is type-determinable only: a runtime value that happens to be truthy but whose *type* is `boolean` stays flagged (conservative; never hides a real hang).
