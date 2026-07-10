# seyfert/i18n-resolve-with-get

`ctx.t.some.path` returns a seyfert `SeyfertLocale` **proxy** whose leaves expose a `.get(locale?)` method. Using the proxy directly as a string yields the proxy object, not the localized text.

This rule flags a locale proxy used without `.get()`, conservatively only inside the two clearly-string contexts: a template literal `${...}` expression and string `+` concatenation. Detection is anchored to seyfert's langs router type, so a non-seyfert object with a `get` method is never flagged.

## ✅ Valid

```ts
await ctx.write({ content: `${ctx.t.welcome.get()}` });
const msg = ctx.t.welcome.get(ctx.interaction.locale);
```

## ❌ Invalid

```ts
await ctx.write({ content: `${ctx.t.welcome}` }); // the proxy, not the text
const msg = 'Hi ' + ctx.t.welcome;
```

## Notes

Conservative by design: a proxy assigned to a variable and used elsewhere (outside a `${...}`/`+`) is not flagged, to keep zero false positives.
