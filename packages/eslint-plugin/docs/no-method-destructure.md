# seyfert/no-method-destructure

Destructuring a method off a seyfert object detaches it from its `this`, so the standalone reference throws when called:

```
TypeError: Cannot read properties of undefined (reading 'interaction')
    at editOrReply (seyfert/lib/commands/applications/chatcontext.js)
```

seyfert's context / structure / builder methods are `this`-bound prototype methods — e.g. `ctx.editOrReply` reads `this.interaction`, so `const { editOrReply } = ctx` and then `editOrReply(...)` crashes.

The rule flags a destructured **method** of any seyfert class. **Getters and plain properties are safe** — destructuring reads their value once — and are never flagged.

> The general form of this footgun is covered by [`@typescript-eslint/unbound-method`](https://typescript-eslint.io/rules/unbound-method/). This is the zero-config, seyfert-scoped variant: it fires only on seyfert-declared methods, so it needs no whole-codebase tuning and stays in `recommended`.

## ✅ Valid

```ts
async run(ctx: CommandContext) {
  const { author, client } = ctx;                 // getters / properties — safe
  await ctx.editOrReply({ content: `Hi ${author.username}` }); // method stays on ctx
}
```

## ❌ Invalid

```ts
export default createMiddleware<void>((middle) => {
  const { editOrReply } = middle.context; // detached from its `this`
  editOrReply({ content: 'x' });          // → TypeError at runtime
});
```

## Notes

Because seyfert ships type declarations (no method bodies), the rule flags a destructured method regardless of whether that specific method uses `this` — seyfert's instance methods are `this`-bound by construction, and destructuring a method to call it standalone is a mistake either way.
