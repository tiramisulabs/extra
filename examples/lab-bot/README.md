# Lab example bot

A small Seyfert bot with a `@slipher/lab` project. Members send a request with `/support`, the bot posts it to a staff-only channel, and staff claim it. No Discord token or database is needed to test it.

- `src/` is the bot. `seyfert.config.mjs` points Seyfert at the compiled handlers in `dist/src`.
- `lab/project.ts` defines the `support` scenario: a guild, roles, a private channel, and two actors (`member`, `staff`). The `botCanManageRoles` parameter shows how a scenario can vary the world.
- `test/lab.test.ts` drives the scenario headlessly and replays a recorded session.

## Run

From the repository root:

```sh
pnpm install
pnpm turbo build --filter lab-bot...
pnpm --filter lab-bot test
pnpm --filter lab-bot lab   # open the same scenario in the browser UI
```

Use it as a template: replace the handlers in `src/` and describe your own guilds, channels, and actors in `lab/project.ts`.
