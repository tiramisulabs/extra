# @slipher/lab

Define serializable presets and run Seyfert scenarios against `@slipher/testing`. The root and
`/protocol` entrypoints are safe to load without starting a bot or importing Node process APIs.

## Define a project

```ts
import { defineProject, defineScenario, param } from '@slipher/lab';

const scenario = defineScenario({
  id: 'welcome',
  version: 1,
  title: 'Welcome',
  params: { greeting: param.string({ default: 'Hello' }) },
  world(w) {
    const guild = w.guild('guild', { name: 'Lab' });
    w.channel('general', guild, { name: 'general' });
    w.member('alice', guild);
  },
  actors: refs => ({
    alice: { userId: refs.alice, guildId: refs.guild, channelId: refs.general },
  }),
});

export const project = defineProject({
  name: 'my-bot',
  scenarios: [scenario],
  // Import application code here, after configure/resources.setup/world.
  bot: async () => {
    const { MyCommand } = await import('./commands.js');
    return { commands: [MyCommand] };
  },
});
```

`w.guild/role/channel/member/message` assign stable snowflake IDs from
`project:scenario:ref`. Pass an explicit `id` for guilds, roles, channels and
messages; call `w.ref(name, id)` before `w.member(name, guild, options)` to
override a member ID. A member's registered `user.id` always equals its ref,
even when `options.user` came from `apiUser()` with a generated ID. An explicit
ref that conflicts with a preset override throws. To add the same user to
another guild, reuse its ref: `w.member('alice', otherGuild)`.
The returned ID and the name-to-ID map passed to `actors` are the actual IDs.
`w.builder` exposes the underlying testing world builder for less common fixtures.
Configure the bot once with `const bot = w.bot({ id: w.ref('member.bot'), username: 'support-bot', globalName: 'Support Bot', avatar: null })`. Seed its guild member with `w.builder.registerBotMember(guild)` and a bot message with `w.message('welcome', channel, { author: bot, content: 'Ready' })`. `project.bot` can instead return `createMockBot` options with `botUser` when the scenario does not configure the profile. `Session.describe()` uses that identity in `names.users` and marks each guild member with `bot: boolean`.
Presets can provide `refs: { name: id }` to override IDs. `log().preset`
records the effective params, service variants, and every resolved ref. Actions
and locators accept a ref name or the ID of an entity currently in the world;
unknown names and IDs fail with the available refs.

## Run

```ts
import { createSession, replay } from '@slipher/lab/runtime';

const preset = { scenario: { id: 'welcome', version: 1 }, params: { greeting: 'Hi' } };
const session = createSession(project, preset);
await session.start();
try {
  await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'welcome' });
  console.log(await session.inspect());
} finally {
  await session.dispose();
}
```

`start` runs configure → resources.setup → world → bot → selected service variants →
requires → seed. On failure it closes the bot and disposes acquired resources, with a
timeout and a visible cleanup error. `reset` closes the bot, disposes resources,
and starts a fresh session in the same setup order. If cleanup fails or times
out, reset rejects and leaves the session stopped.
`act` throws on failure and also records the failed outcome in `log()`.
`createCheckpoint(await session.log(), name, arrival)` writes format version 1
with the lab/protocol versions, effective preset, actions, recorded outcomes,
and explicit arrival conditions. `replay(project, checkpoint)` starts a fresh
session, repeats actions in order, compares each action result and dispatch
count, then checks arrival. Local modal and message actions are recorded without
producing Discord interactions. No pending promise or collector is restored from a snapshot. Replay
does not compare global REST order.

Arrival conditions are `{ path, equals }` on `inspect()`,
`{ view: { actor, channel }, contains, absent? }`,
`{ role: { guild, member, role }, present }`,
`{ project: { name, args?, path }, equals }` on `inspectProject(name, args)`,
or `{ action: zeroBasedIndex, ok, error? }` (the error is a regular expression).
The project inspector can expose JSON projections of external resources while
the lab remains independent of their storage technology. Missing or mismatched
conditions throw with the expected and actual values.
View `contains` and `absent` search each visible message's content, embed title,
description, field names and values, footer and author text, TextDisplay content,
button labels, and select placeholders and option labels. They do not search
message IDs, component IDs or serialized JSON escapes.

`exportTest(checkpoint, { format: 'vitest' | 'node', projectModule? })` generates
TypeScript that loads a CommonJS or ESM project module and calls `replay`. The path
can also be stored in `checkpoint.projectModule`. If no arrival condition was
pinned, the generated test fails with an explanation; recorded clicks and
outcomes alone do not declare the intended final state. The compiled project
module can export `project`, a default project, or the project directly.

`view(actor, channelRef)` returns the original message payloads filtered by the
actor's current channel permissions, live receipts, and ephemeral ownership.
Closing a modal with `closeModal` is client state: its pending form remains live,
and the original button, select, or slash trigger reopens it without another
dispatch. `reopenModal` opens it directly. `dismissMessage` hides an actor's own
ephemeral message locally for that actor; the message is also excluded from
locators. A dismiss with `messageRef` targets only that visible message; replay
uses its recorded visible text to find a new instance. The pending-flow guard still rejects unrelated actions while a form
is waiting.
Without `ReadMessageHistory`, the actor sees messages received while connected
with `ViewChannel`, plus their own ephemeral messages. Granting access later does
not deliver earlier messages. The view reports `history-hidden:N` only when it
hides N messages. Role and overwrite changes take effect on the next view.
Choosing a different actor in the UI does not reconnect anyone. `reset()` starts
a new session after seeding; checkpoint replay reconstructs receipts from the
seed and ordered actions. This deterministic model is not a complete Discord
gateway. `describe()` lists channel access
per actor using current `ViewChannel` permissions. `inspect()` returns the world,
REST history, pending modals and collectors, and diagnostics. Use
`await session.commandSchemas()` for full slash command schemas; it loads
deferred commands, so it is separate from the inspector snapshot. `observe()`
streams REST, dispatch, world and interaction changes alongside session events.
External role changes use `act({ kind: 'admin', op: 'addRole' | 'removeRole',
guild, member, role })` and appear in the log.

## Child process

```ts
import { createChildSession } from '@slipher/lab/child';

const child = createChildSession({
  projectModule: '/absolute/path/to/compiled/project.js',
  preset,
  // For TypeScript source, pass the project's own loader, for example:
  // execArgv: ['--import', 'tsx'],
});
await child.start();
try {
  await child.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'welcome' });
} finally {
  await child.dispose();
}
```

The module can export `project`, a default project, or the project directly.
The child tries `require` and falls back to dynamic `import` for ESM.
Only JSON-compatible data crosses IPC. `reset()` disposes the old child and
starts a fresh process with a fresh module cache. `dispose()` waits for process
exit. If cleanup or exit exceeds its deadline, the child is killed and the
error reports that external cleanup may be pending. Reset does not start a new
child after cleanup failure.
Ordinary child RPCs use a 30 second deadline by default. Set `rpcTimeoutMs`
in `createChildSession` to change it. A timed out call rejects all pending RPCs,
stops the session, and requests child disposal before forcing exit. The error
reports that external cleanup may still be pending. A start timeout also
requests disposal with its own deadline before forcing exit.

## Local host

`startHost({ projectModule, cwd?, dataDir?, hostname?, port?, uiDir?, execArgv?, env?, startTimeoutMs?, disposeTimeoutMs?, rpcTimeoutMs? })`
from `@slipher/lab/host` returns `{ url, close() }`. It binds to `127.0.0.1`
and an available port by default. Binding accepts only `127.0.0.1`, `::1`, or
`localhost`; other hostnames fail before listening. Only local `Host` and `Origin` authorities
are accepted. `GET /api/describe` loads project metadata in a disposable child
without starting a session. `POST /api/session` accepts `{ preset }` and returns
`{ ok: true }` (201); it disposes an existing session first. `DELETE /api/session`
returns `{ ok: true }`. `POST /api/rpc` accepts a validated `BridgeRequest`
for `session.act`, `session.view`, `session.inspect`, `session.commandSchemas`,
`session.inspectProject`, or `session.log`, and returns a `BridgeResponse`.
Bad requests return JSON `{ error }` with 400; an absent session returns 409.
`GET /api/events` streams SSE with monotonically increasing `id`, `event`, and
JSON `data`; `Last-Event-ID` replays recent events. Events include
`session-event`, `session-started`, `session-stopped`, `session-error`, and `child-exit`.
`GET /api/checkpoints` lists names; `POST /api/checkpoints` accepts
`{ checkpoint }`; `GET /api/checkpoints/:name` loads one;
`POST /api/checkpoints/:name/replay` first disposes any visual session, emits
`session-stopped` with `{ "reason": "replay" }`, then runs it in a new child.
Cleanup failure prevents replay and returns a visible error. Checkpoint files
reject symlinks and are saved by atomic rename within `dataDir`.
`GET /api/checkpoints/:name/export?format=node|vitest` returns `{ code }`.
The host validates the checkpoint format, lab/protocol and scenario versions
on save/load. Names use only letters, digits, `_` and `-`; data is stored as
JSON in `dataDir` (default `.slipher-lab/` beside the project module).
`uiDir` serves static files with an `index.html` fallback. Without UI, `/`
explains how to install it.

Run `slipher-lab --project /absolute/path/to/project.js [--cwd /path/to/bot] [--data /path/to/data] [--port N]
[--host 127.0.0.1|::1|localhost] [--rpc-timeout-ms N] [--node-arg <arg>]... [--ui <dir>]` to print the URL.
`--cwd` sets the child process directory for project description, sessions, and replay; by default it inherits the CLI's directory.
The CLI uses `@slipher/lab-ui/dist` when the optional peer is installed.

## Hosted mode

Pass `hosted: { publicOrigin, access: { mode: 'trusted-proxy' } }` and
`build: { revision }` to `startHost`, or run the CLI with
`--public-origin <origin> --access trusted-proxy --build-revision <revision>`.
The CLI also accepts `--max-runs`, `--idle-ttl-ms`, `--max-run-ms`, repeatable
`--child-env NAME`, `--export-module`, and `--build-ref`, `--build-url`,
`--build-time`. Build fields can instead come from `SLIPHER_LAB_BUILD_REVISION`,
`SLIPHER_LAB_BUILD_REF`, `SLIPHER_LAB_BUILD_URL`, and `SLIPHER_LAB_BUILD_TIME`.
API callers can use `access: { mode: 'authorize', authorize(req) }`.

Hosted mode gives each browser an isolated, bounded run, identified by an
HttpOnly, SameSite=Strict cookie. It requires an exact Host and Origin for
mutations, checks the revision on checkpoint save and replay, and clears
run-scoped checkpoints when the run ends or the host restarts. It has no
accounts. `trusted-proxy` assumes every request has already passed an access
proxy: the container port must never be public. No incoming authentication or
forwarding header is trusted, including `Authorization` and `X-Forwarded-*`.
Export checkpoint JSON or test code before ending a run if it must survive.
The catalogue opens without a run; only Start creates one. Replay requires an
active run cookie. A remote `publicOrigin` must use HTTPS; HTTP is accepted only
for loopback container QA.

A generic deployment uses a dedicated Dockerfile that installs pinned
dependencies, builds the project and lab, runs the CLI as a non-root user,
exposes an internal port, and health-checks `/api/health`. Use the commit SHA
when the provider supplies it; otherwise derive a deterministic content identity
from the paths and bytes of the copied build context (for example,
`content-<hex>`), never labeling it as a commit. The revision identifies the
build for checkpoints and update notices; `instanceId` detects a restart of the
same build. Connect that port only to an HTTPS access proxy, with
no host port mapping; set `publicOrigin` to the served origin. Put access control
on the proxy domain and verify that preview domains inherit it. Enable provider
previews only for trusted PR authors, with collaborator permissions required,
an explicit preview label, a count limit, HTTPS, and cleanup on close. Never
build untrusted fork PRs on a shared host. Set CPU and memory limits for each
container; each run starts a child process and may use additional project
resources. Keep production secrets out of the preview environment.

For example, adapt this Dockerfile shape to the project's build scripts. Send
only a filtered build context: exclude `.git`, dotenv files, credentials, local
data, and `node_modules` before `COPY`.

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /app
COPY . .
ARG SOURCE_REVISION
RUN if [ -n "$SOURCE_REVISION" ]; then printf '%s\n' "$SOURCE_REVISION"; \
    else find . -type f -print0 | sort -z | xargs -0 sha256sum -z | sha256sum | \
      awk '{print "content-" substr($1,1,16)}'; fi > /tmp/slipher-lab-build-revision
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
USER node
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["./preview-entrypoint.sh"]
```

The entrypoint reads `/tmp/slipher-lab-build-revision`, exports it as
`SLIPHER_LAB_BUILD_REVISION`, and supplies `--host 0.0.0.0 --port 8080`,
`--public-origin`, and `--access trusted-proxy`, along with the project module
and an ephemeral data directory. The access proxy provides the team gate; the
lab host never reads forwarding or authentication headers as proof of access.
