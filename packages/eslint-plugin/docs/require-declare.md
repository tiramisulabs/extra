# seyfert/require-declare

Classes that extend a seyfert command base (`Command`, `SubCommand`, `ContextMenuCommand`, …) must be decorated with `@Declare`. Without it seyfert has no name/description/type to register the command, so it is silently ignored.

Type-aware: the base class must genuinely come from the `seyfert` package — a local `class Command {}` never triggers — transitive bases are followed, and `abstract` intermediate bases are exempt. A `@Declare` inherited from a base class counts (the decorator sets class fields, so subclasses inherit them), and a base the rule can't inspect — a factory call, a mixin, or a class from a declaration file — is never assumed to lack one.

## ✅ Valid

```ts
import { Command, Declare } from 'seyfert';

@Declare({ name: 'ping', description: 'Pong' })
export default class Ping extends Command {}

// Abstract intermediate base — not a registered command itself.
abstract class Base extends Command {}
```

## ❌ Invalid

```ts
import { Command } from 'seyfert';

export default class Ping extends Command {} // missing @Declare
```
