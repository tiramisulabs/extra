# seyfert/context-menu-declare

A class extending seyfert's `ContextMenuCommand` must declare its kind: its `@Declare` has to set `type: ApplicationCommandType.User | .Message` and must **not** include a `description` (descriptions are chat-command only).

TypeScript can't catch this — the `@Declare` parameter is a union that isn't tied back to the class it decorates. A `type`/`description` supplied through a spread is treated as unknown (no false positive).

## ✅ Valid

```ts
@Declare({ type: ApplicationCommandType.Message, name: 'Report message' })
class Report extends ContextMenuCommand {}
```

## ❌ Invalid

```ts
// Missing `type` AND carries a `description` (matches the chat-command shape by accident):
@Declare({ name: 'Report message', description: 'd' })
class Report extends ContextMenuCommand {}

// Has `type` but still includes a `description`:
@Declare({ type: ApplicationCommandType.Message, name: 'Report', description: 'd' })
class Report2 extends ContextMenuCommand {}
```
