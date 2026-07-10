# seyfert/decorator-on-command

Seyfert's command decorators — `@Declare`, `@Options`, `@Middlewares`, `@Locales`, `@LocalesT` — may only decorate a class that extends a seyfert command base (`Command`, `SubCommand`, …). On any other class they do nothing.

(`@Group`/`@Groups`/`@GroupsT`/`@AutoLoad` have their own placement rule, [`decorator-target`](./decorator-target.md).) Type-aware: only seyfert's own decorators are checked; the base is resolved through the type checker (transitive bases included).

## ✅ Valid

```ts
@Declare({ name: 'ping', description: 'Pong' }) class Ping extends Command {}
@LocalesT() class Localized extends Command {}
```

## ❌ Invalid

```ts
@Declare({ name: 'x', description: 'd' }) class X {}      // not a command class
@Options({ q: createStringOption({ description: 'q' }) }) class Y {}
```

## Notes

A command base reached only through a TypeScript mixin (`extends Mix(Command)`) or a conditional base is not detected — idiomatic plain inheritance is handled.
