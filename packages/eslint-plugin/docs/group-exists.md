# seyfert/group-exists

A subcommand's `@Group('x')` must reference a group declared in its parent command's `@Groups` / `@GroupsT` — by key **or** alias. A typo silently routes the subcommand into a group that doesn't exist.

The rule runs from the **command** (which owns the group declarations) and resolves its subcommands the same way seyfert's loader does:

- **`@Options([Sub, ...])`** — each subcommand class is resolved through the type checker; the error is reported on the offending subcommand reference.
- **`@AutoLoad()`** — every `SubCommand` default-exported from a `.ts` file in the command's directory (recursive); the error is reported on the `@AutoLoad` decorator, naming the subcommand and file (it lives in another file, so ESLint can't underline it directly).

Group declarations are resolved through `const`/imports, spreads, shorthand, `defineGroups(...)`, and base command classes (seyfert's group decorators are inherited, and `@Groups` and `@GroupsT` are merged). Only literal `@Group` names are checked.

## ✅ Valid

```ts
// ban.ts
@Group('moderation') export default class Ban extends SubCommand {}

// admin.ts
@Groups({ moderation: { defaultDescription: 'Moderation', aliases: ['mod'] } })
@AutoLoad()
export default class Admin extends Command {}
```

## ❌ Invalid

```ts
// ban.ts
@Group('moderaton') export default class Ban extends SubCommand {} // typo

// admin.ts — declares 'moderation', not 'moderaton'
@Groups({ moderation: { defaultDescription: 'Moderation' } })
@AutoLoad()
export default class Admin extends Command {}
```

## Notes

Conservative limitations (these under-report, never over-report): a subcommand exported as `export { X as default }`, or compiled-`.js` siblings, are not resolved. A command whose groups can't be read in full is skipped rather than guessed: a non-literal `@Groups` argument (`@Groups(config.groups)`, `@Groups(makeGroups())`), an unresolved spread or computed key, unreadable `aliases`, or a base class from a declaration file, factory or mixin.

## Related

- [`prefer-typed-group`](./prefer-typed-group.md) — nudges toward the `@Group(groups, name)` overload that TypeScript validates at the call site.
