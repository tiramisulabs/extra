# seyfert/decorator-on-command

Seyfert's command decorators — `@Declare`, `@Options`, `@Locales`, `@LocalesT` — may only decorate a class that extends a seyfert command base (`Command`, `SubCommand`, …). On any other class they are ignored, or worse: `@Declare` overwrites a component's `type`, so seyfert stops routing its interactions to it.

`@Middlewares` is shared by commands and components: it may also decorate a class that extends `ComponentCommand` or `ModalCommand`, whose middlewares seyfert's component handler runs before `run()`.

(`@Group`/`@Groups`/`@GroupsT`/`@AutoLoad` have their own placement rule, [`decorator-target`](./decorator-target.md).) Type-aware: only seyfert's own decorators are checked; the base is resolved through the type checker (transitive bases included).

## ✅ Valid

```ts
@Declare({ name: 'ping', description: 'Pong' }) class Ping extends Command {}
@LocalesT() class Localized extends Command {}
@Middlewares(['checkPlayer']) class Pause extends ComponentCommand { /* … */ }
```

## ❌ Invalid

```ts
@Declare({ name: 'x', description: 'd' }) class X {}      // not a command class
@Options({ q: createStringOption({ description: 'q' }) }) class Y {}
@Declare({ name: 'b', description: 'd' }) class B extends ComponentCommand { /* … */ } // only @Middlewares applies to components
@Middlewares(['checkPlayer']) class Z {}                   // neither a command nor a component
```

## Notes

A command base reached only through a TypeScript mixin (`extends Mix(Command)`) or a conditional base is not detected — idiomatic plain inheritance is handled.
