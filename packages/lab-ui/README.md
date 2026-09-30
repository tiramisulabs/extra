# @slipher/lab-ui

> **Built for agents first.** The UI helps inspect what an agent-driven session did. It approximates Discord and is not yet a polished or fully reliable tool for manual testing.

Prebuilt browser interface for `@slipher/lab`. It renders what each simulated actor sees in a Discord-like client
and groups the lab tooling (scenario, log, REST, pending interactions, world, project inspectors, checkpoints) in a
separate panel.

The package ships static files only (`dist/`). It has no runtime dependencies and never talks to Discord: the lab
host serves it on `127.0.0.1` and the browser only receives the JSON protocol from `@slipher/lab/protocol`.

## Use

Install it next to `@slipher/lab`; the `slipher-lab` CLI finds it automatically:

```sh
slipher-lab --project dist/lab/project.js
```

Pass `--ui <dir>` to serve another build. Without this package the host still runs and `/` explains how to add it.

## What the interface shows

- The Discord surface: servers, channels (a lock marks channels the current actor cannot view), the conversation
  filtered by the engine's visibility rules, ephemeral messages for their owner, embeds, Components V1/V2, modals,
  and a slash command composer built from the registered command schemas.
- "Viewing as": switch actors from the user bar or a member's profile.
- Live roles: add or remove roles from a member profile. These are external changes (like an admin in Discord) and
  appear in the Lab log with an `admin` badge.
- Lab tooling, marked in amber: pin a visible message or a role as an expected result, save the session as a
  checkpoint, replay it in a fresh session, and export a test.

Rendering is an approximation for development. It does not claim pixel parity with Discord; components the lab does
not represent are shown as an explicit notice instead of being hidden.

## Develop

```sh
pnpm --filter @slipher/lab-ui build   # typecheck + vite build to dist/
pnpm --filter @slipher/lab-ui test    # HostClient against a real host, rendering checks
```

Open `?fixture` on a served build to use synthetic data without a host.
