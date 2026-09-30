# @slipher/lab

> **Built for agents first.** The lab is designed so coding agents can drive a bot, check what each actor sees, and turn a run into a test. People can use it too, especially through the UI, but it approximates Discord and is not yet a polished or fully reliable tool for manual QA.

Run Seyfert bots against scripted Discord scenarios built on `@slipher/testing`. A scenario describes guilds, roles, channels, members and actors; a session runs your real handlers against it, so you can drive it from tests or from the browser UI in `@slipher/lab-ui`.

The root and `/protocol` entrypoints are safe to load without starting a bot or importing Node process APIs.

## Define a project

```ts
import { defineProject, defineScenario, param } from '@slipher/lab';

const scenario = defineScenario({
  id: 'basic',
  version: 1,
  title: 'One guild, one member',
  params: { locked: param.boolean({ default: false }) },
  world(w, { params }) {
    const bot = w.bot({ username: 'my-bot' });
    const guild = w.guild('guild', { name: 'Lab' });
    const general = w.channel('general', guild, {
      name: 'general',
      overwrites: params.locked ? [{ id: guild, type: 'role', deny: ['SendMessages'] }] : [],
    });
    w.member('alice', guild);
    w.builder.registerBotMember(guild);
    w.message('hello', general, { author: bot, content: 'Hi!' });
  },
  actors: refs => ({
    alice: { userId: refs.alice, guildId: refs.guild, channelId: refs.general },
  }),
});

export const project = defineProject({
  name: 'my-bot',
  scenarios: [scenario],
  // Import application code here so it loads after the world is ready.
  bot: async () => {
    const { commands } = await import('./commands.js');
    return { commands };
  },
});
```

- **Refs.** Every entity has a name (`'guild'`, `'alice'`) that maps to a stable snowflake derived from the project, scenario and name. Actions, locators and expectations accept a ref or a raw ID. Presets can override IDs with `refs: { name: id }`.
- **Params and services.** Scenario `params` (boolean, string, number, enum) and project `services` (named variants) are chosen per preset.
- **Resources.** `resources.setup/dispose` owns external fixtures such as a database. `requires` and `seed` run after the bot starts, and `inspect` exposes JSON projections of those resources.
- **Bot identity.** `w.bot()` configures the bot user once; `w.builder` exposes the underlying testing world for anything else.

## Run a session

```ts
import { createSession, replay } from '@slipher/lab/runtime';

const session = createSession(project, { scenario: { id: 'basic', version: 1 } });
await session.start();
try {
  await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'ping' });
  const { messages } = await session.view('alice', 'general');
} finally {
  await session.dispose();
}
```

`act` accepts:

- user actions: `slash`, `click`, `select`, `submitModal`. Clicks and selects locate their source message by channel plus `customId`, `contains` or `messageRef`.
- admin actions: `addRole` / `removeRole`, for role changes made outside the bot.
- local actions: `closeModal`, `reopenModal` and `dismissMessage`. These change only what the actor sees and dispatch nothing.

A failed action throws, and its outcome is also recorded in `log()`.

`view(actor, channel)` returns what that actor can see:

- Channel permissions and ephemeral ownership are applied.
- Without `ReadMessageHistory`, the actor only sees messages that arrived while they had access.
- Role changes take effect on the next view.

Other session methods:

- `describe()`: actors, guilds, and channel access.
- `inspect()`: world, REST history, pending modals and collectors.
- `commandSchemas()`: registered commands.
- `observe(listener)`: streams session changes.
- `reset()`: restarts from the seed.

## Checkpoints and replay

`createCheckpoint(log, name, arrival)` stores the preset, the recorded actions and their outcomes, plus the conditions that describe the expected end state:

```ts
{ view: { actor, channel }, contains: 'text', absent?: true }
{ role: { guild, member, role }, present: true }
{ path: 'world.members.0.roles', equals: [...] }        // on inspect()
{ project: { name, args?, path }, equals: value }       // on a project inspector
{ action: 2, ok: false, error: 'regex' }
```

`replay(project, checkpoint)` or `replay(project, log, arrival)` starts a fresh session, repeats the actions, compares each outcome, and checks the arrival conditions. Replay repeats actions; it never restores promises or collectors, so component and modal IDs must stay stable between runs.

`exportTest(checkpoint, { format: 'vitest' | 'node', projectModule })` generates a test that replays the checkpoint. A checkpoint without arrival conditions exports a failing test that asks you to add one.

## Child process

`createChildSession({ projectModule, preset, execArgv?, cwd?, env? })` from `@slipher/lab/child` runs the same session API in a forked process. The module may export `project`, a default project, or the project itself, as CommonJS or ESM. `reset()` starts a new process, so module state is fresh. Pass `execArgv: ['--import', 'tsx']` to load TypeScript sources. RPCs time out after `rpcTimeoutMs` (30s by default); a timeout stops the child.

## Local host and UI

```sh
slipher-lab --project dist/lab/project.js
```

The CLI starts an HTTP/SSE host on `127.0.0.1` and serves `@slipher/lab-ui` when it is installed. Useful flags:

- `--cwd <dir>`: working directory for the bot.
- `--data <dir>`: checkpoint storage. Defaults to `.slipher-lab/` next to the project.
- `--port N`
- `--node-arg <arg>`: repeatable.
- `--ui <dir>`

Programmatic use is `startHost(options)` from `@slipher/lab/host`. It returns `{ url, close() }`.

The host only binds to loopback addresses and only accepts local `Host` and `Origin` headers. Each browser session runs in a child process, and checkpoints are saved as JSON files in the data directory.

## Hosted mode

Hosted mode shares one lab with a team, for example as a PR preview:

```sh
slipher-lab --project dist/lab/project.js --host 0.0.0.0 --port 8080 \
  --public-origin https://lab.example.com --access trusted-proxy --build-revision "$GIT_SHA"
```

Each browser gets an isolated run, tracked by an HttpOnly cookie. `--max-runs`, `--idle-ttl-ms` and `--max-run-ms` bound how many runs exist and how long they last. The child process receives only `PATH`, `HOME`, `TMPDIR`, `LANG`, `TZ`, `NODE_ENV` and the variables listed with `--child-env NAME`.

Checkpoints are tied to their run and the build revision. They are removed when the run ends or the host restarts, so export anything worth keeping.

The host has no accounts. `trusted-proxy` means an access proxy in front of it has already authenticated every request, so:

- Never expose the port publicly.
- Keep production secrets out of the preview environment.
- Only build previews for trusted authors.

API users can pass `access: { mode: 'authorize', authorize(req) }` instead.

A container needs to install and build the project, run the CLI as a non-root user, and health-check `GET /api/health`.
