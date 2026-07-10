# seyfert/declare-description

Discord rejects an empty chat-command/option description and any description longer than 100 characters. seyfert v5 makes `description` required by type but cannot check its content — this rule does.

Length is measured by **Unicode code point** (Discord's unit), so emoji don't count double. Only literal strings are checked; a description built dynamically is skipped. Context-menu `@Declare` (which omits a description) is handled by [`context-menu-declare`](./context-menu-declare.md).

## ✅ Valid

```ts
@Declare({ name: 'stats', description: 'Show server statistics' }) class Stats extends Command {}

createStringOption({ description: '📊'.repeat(51) }); // 51 code points ≤ 100
```

## ❌ Invalid

```ts
@Declare({ name: 'stats', description: '' }) class Stats extends Command {} // empty
createStringOption({ description: 'a'.repeat(101) });                       // > 100 characters
```
