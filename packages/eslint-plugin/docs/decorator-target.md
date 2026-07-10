# seyfert/decorator-target

Seyfert's structural decorators must target the right command class:

- `@Group` only on a `SubCommand`
- `@Groups` / `@GroupsT` / `@AutoLoad` only on a `Command`

Type-aware: only seyfert's own decorators are checked, and the base class is resolved through the type checker (transitive bases included), so a same-named local/third-party decorator never triggers.

## ✅ Valid

```ts
@Group('moderation') class Ban extends SubCommand {}
@AutoLoad() class Admin extends Command {}
@GroupsT({ moderation: { defaultDescription: 'Moderation' } }) class Admin2 extends Command {}
```

## ❌ Invalid

```ts
@Group('moderation') class Admin extends Command {}   // @Group only on SubCommand
@AutoLoad() class Ban extends SubCommand {}           // @AutoLoad only on Command
```

## Related

- [`group-exists`](./group-exists.md) — validates that a `@Group` name actually exists in the command's groups.
