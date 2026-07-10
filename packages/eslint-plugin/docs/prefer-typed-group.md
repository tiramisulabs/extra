# seyfert/prefer-typed-group

> **Opt-in** — not part of `configs.recommended`. Enable it explicitly (`'seyfert/prefer-typed-group': 'warn'`).

seyfert's `@Group(name)` takes a bare string that is never checked. The two-argument overload `@Group(groups, name)` — where `groups` is a `defineGroups(...)` / `@Groups` object — constrains `name` to `keyof typeof groups`, turning a typo into a **compile error** (TypeScript, in your editor).

This rule nudges the single-argument form toward the typed one. It is a **suggestion**, not a correctness error: the single-argument form works at runtime.

## Scope — what it does and does *not* do

This is a **single-file, local** rule. It looks at exactly one `@Group(...)` decorator and flags it when it has a single argument and resolves to seyfert's `Group`. It does **not**:

- look at the parent command,
- resolve other files, or
- read the filesystem / understand `@AutoLoad`.

So it fires the same way no matter how your subcommands are wired. It never *validates* the group name — it only steers you to the form where **TypeScript** does. That `keyof groups` check happens at the call site (in the subcommand's own file), so it works even when the subcommand lives in a separate file or is loaded by `@AutoLoad` — **provided the subcommand imports the shared `groups` object** the parent also uses.

If you want the group name *validated by the linter* (including resolving `@Options` and scanning `@AutoLoad` directories), that's a different rule: [`group-exists`](./group-exists.md). The two are complementary — use both.

## ✅ Valid

```ts
// groups.ts — a shared definition the command and its subcommands import.
export const groups = defineGroups({ moderation: { defaultDescription: 'Moderation' } });

// ban.ts
import { groups } from './groups';
@Group(groups, 'moderation') // TS checks 'moderation' ∈ keyof typeof groups
class Ban extends SubCommand {}
```

## ❌ Flagged (suggestion)

```ts
@Group('moderation') class Ban extends SubCommand {} // unchecked string
```

## Related

- [`group-exists`](./group-exists.md) — the lint-time validator: checks a `@Group` name against the parent command's declared groups, resolving both `@Options` and `@AutoLoad`.
