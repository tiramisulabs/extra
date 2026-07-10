# seyfert/no-deep-imports

🔧 **Fixable.** Prefer the `seyfert` package root over deep `seyfert/lib/...` paths (including the bare `seyfert/lib` barrel) when the symbol is re-exported from the root.

The root export surface is read from the real seyfert types (expanding `export *`), so a symbol that genuinely only lives deep — e.g. `CommandHandler`, `HandleCommand` — is never flagged.

## ✅ Valid

```ts
import { Command, AutoLoad } from 'seyfert';
// Deep import is fine when the API is not root-exported:
import { HandleCommand } from 'seyfert/lib/commands/handle';
```

## ❌ Invalid

```ts
import { AutoLoad } from 'seyfert/lib';                           // → 'seyfert'
import { Command } from 'seyfert/lib/commands/applications/chat'; // → 'seyfert'
```
