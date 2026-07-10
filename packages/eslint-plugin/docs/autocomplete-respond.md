# seyfert/autocomplete-respond

An autocomplete interaction must be answered with `.respond(...)`. seyfert's `AutocompleteInteraction` also exposes a `.reply(...)` method, but it is `@internal` and **throws at runtime** — it only exists so the type lines up with the other interactions.

The rule flags `<x>.reply(...)` whenever `x`'s type is (or extends) seyfert's own `AutocompleteInteraction`, so a plain object with a `reply` method or a different interaction type is never flagged.

## ✅ Valid

```ts
createStringOption({
  description: 'Search',
  autocomplete(interaction) {
    interaction.respond([{ name: 'Apple', value: 'apple' }]);
  },
});
```

## ❌ Invalid

```ts
createStringOption({
  description: 'Search',
  autocomplete(interaction) {
    interaction.reply([]); // internal — throws at runtime
  },
});
```
