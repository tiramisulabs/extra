# seyfert/config-default-export

seyfert loads a `seyfert.config.*` file through its **default export**, so the result of seyfert's `config.bot(...)` / `config.http(...)` must be exactly the file's `export default`. If it isn't, seyfert can't read the config.

Type-aware (not filename-based): the call's object must resolve to seyfert's own `config`. An `as` / `satisfies` / `<T>` / `!` wrapping the default export is unwrapped.

## ✅ Valid

```ts
import { config } from 'seyfert';

export default config.bot({
  token: process.env.TOKEN ?? '',
  intents: ['Guilds'],
  locations: { base: 'src', commands: 'commands' },
});
```

## ❌ Invalid

```ts
import { config } from 'seyfert';

config.bot({ /* … */ });          // called but never exported
const c = config.bot({ /* … */ }); // not the default export
```

## Notes

Only the idiomatic direct form `export default config.bot(...)` is accepted; an indirection like `const c = config.bot(...); export default c` is conservatively flagged.
