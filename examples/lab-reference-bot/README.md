# Seyfert support bot

A small Seyfert bot and a headless lab project. It has no database, resource hooks, service variants, or Discord token requirement for tests.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @slipher/testing build
pnpm --filter @slipher/lab build
pnpm --filter lab-reference-bot build
pnpm --filter lab-reference-bot test
pnpm --filter lab-reference-bot run lab:check
```

`lab:check` runs with Node and `node:assert`, without Vitest. From this directory, the local lab host can open the same compiled project with `slipher-lab --project dist/lab/project.js` once the CLI is available.

The project is ESM. `seyfert.config.mjs` loads the compiled handlers from `dist/src`. The lab uses `loadFromConfig` and a `loadModule` callback to import those ESM handlers. `src/index.ts` is the real Discord entry point and is not started by headless runs.

## Scenario

`lab/project.ts` defines `support-request@1` with `topic` (`question` or `bug`) and `botCanManageRoles` (boolean). Its refs are `guild`, `role.staff`, `role.requester`, `role.bot`, `role.manage-roles`, `channel.support`, `channel.staff`, `member.member`, `member.staff`, and `member.bot`. The actors are `member` and `staff`.

The member runs `/support open` (the lab slash action sets `command: 'support'` and `subcommand: 'open'`), clicks **Open form**, and submits the modal. The bot posts a request with **Claim** in `#staff` and acknowledges the member ephemerally. The guild gives `@everyone` normal member permissions, including `ViewChannel`, `SendMessages`, `ReadMessageHistory`, and `UseApplicationCommands`, so the member can see `#support` and their ephemeral reply. `#staff` denies `ViewChannel` to everyone and allows Staff and the bot. Staff can claim the request; the member cannot see that channel. The bot role sits above Requester, so role assignment succeeds when the bot has `ManageRoles`. The scenario also seeds a `Manage Roles` role that an admin action can grant to the bot during a running session.
