# Lab example bot

A small Seyfert bot with a `@slipher/lab` project. Members send a request with `/support`, the bot posts it to a staff-only channel, and staff claim it. No Discord token or database is needed to test it.

- `src/` is the bot. `seyfert.config.mjs` points Seyfert at the compiled handlers in `dist/src`.
- `lab/project.ts` defines the shared bot workspace: a guild, roles, a private channel, and two actors (`member`, `staff`). All compiled handlers load from the same bootstrap.
- `lab/preview.ts` adds only a parameter default for a PR preview without Manage Roles. The world and actors come from the shared project.
- `test/lab.test.ts` exercises both preparations headlessly and replays a recorded session.

## Run

From the repository root:

```sh
pnpm install
pnpm turbo build --filter lab-bot...
pnpm --filter lab-bot test
pnpm --filter lab-bot lab          # shared workspace
pnpm --filter lab-bot lab:preview  # shared workspace plus the PR extension
```

Use it as a template: replace the handlers in `src/` and describe your shared guilds, channels and actors in `lab/project.ts`. Add temporary PR conditions in a separate preview module. Keep only the preparation needed by a useful regression beside its exported test; it does not need to join the shared project’s catalogue.
