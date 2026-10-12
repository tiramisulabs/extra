# @slipher/lab

> **Built for agents first.** The lab is designed so coding agents can drive a bot, check what each actor sees, and turn a run into a test. The browser UI also supports manual checks of conversations, components, modals and checkpoints. It simulates Discord rather than connecting to its services; verify Discord-specific behavior against a live bot before relying on the simulation alone.

Run a Seyfert bot in a reusable Discord workspace built on `@slipher/testing`. Keep the bot startup, guilds, roles, channels, members and actors in a shared preparation. A PR preview can add only the data or conditions it needs. Sessions run real handlers, driven from tests or the browser UI in `@slipher/lab-ui`.

The root and `/protocol` entrypoints are safe to load without starting a bot or importing Node process APIs.

## Define a project

```ts
import { defineProject, defineScenario, param } from '@slipher/lab';

const setup = defineScenario({
  id: 'workspace',
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
  setup,
  // Import application code here so it loads after the world is ready.
  bot: async () => {
    const { commands } = await import('./commands.js');
    return { commands };
  },
});
```

- **Refs.** Every entity has a name (`'guild'`, `'alice'`) that maps to a stable snowflake derived from the project, shared setup and name. Its ID stays the same across preview extensions. Projects without `setup` retain their scenario-derived IDs. Actions, locators and expectations accept a ref or a raw ID. Presets can override IDs with `refs: { name: id }`.
- **Params and services.** Shared `params` (boolean, string, number, enum) are inherited by each scenario. A scenario definition wins when it declares the same parameter; explicit preset values win over either default. Project `services` provides named variants chosen per preset.
- **Resources.** `resources.setup/dispose` owns external fixtures such as an isolated database. The same resource instance reaches `bot`, service variants, `requires`, `seed` and `inspect`. Pass it into the bot’s actual application services; declaring a resource does not connect an existing bot automatically. Each start/reset acquires a new fixture and disposes it after the bot closes, including partial startup failures.
- **Bot identity.** `w.bot()` configures the bot user once; `w.builder` exposes the underlying testing world for anything else.

Modals support text inputs, string and entity selects, radio groups, checkbox groups, checkboxes and file uploads. The host UI uploads file bytes and provides downloadable attachment URLs from the same server. Direct runtime actions can also supply attachment metadata.

## PR preparation without a permanent catalogue

`setup` is a versioned preparation using the same hooks as `defineScenario`. It is runnable on its own; `scenarios` is optional. Put all normal bot commands behind the project’s `bot` bootstrap rather than loading a different bot for each feature.

A preview entry point imports that project and adds its differences:

```ts
import { defineProject, defineScenario, param } from '@slipher/lab';
import { project as sharedProject } from './project.js';

const lockedChannel = defineScenario({
  id: 'locked-channel',
  version: 1,
  title: 'Locked channel',
  params: { locked: param.boolean({ default: true }) },
});

export const project = defineProject({ ...sharedProject, scenarios: [lockedChannel] });
```

A session selecting `locked-channel@1` first builds the shared world, then applies its extension. Parameters and actors are merged, with the extension winning matching names. Both `requires` hooks run after the bot and service variants are ready; if either reports a missing requirement, neither seed runs. Seeds run shared first, then extension. The shared setup runs once when selected directly. A scenario cannot reuse its ID.

This module can live only for the PR. A single workspace can exercise many commands and journeys; an extension is needed only when the initial conditions differ. Legacy projects that declare only `scenarios` keep their current startup order and refs.

Discord transport and world state are simulated. Mongo, Redis or other application services can be real resources, with their own isolated data and cleanup. Isolation of the child process does not isolate a shared external database: the resource hooks own that boundary.

## Run a session

```ts
import { createSession, replay } from '@slipher/lab/runtime';

const session = createSession(project); // runs the shared setup alone
await session.start();
try {
  await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'ping' });
  const { messages } = await session.view('alice', 'general');
} finally {
  await session.dispose();
}
```

`act` accepts:

- user actions: `slash`, `click`, `select`, `submitModal`. Clicks and selects locate their source message by channel plus `customId`, `contains`, `messageRef` or `sequence`. Runtime message IDs execute against the exact visible message; the log records its creation sequence for replay. Named scenario refs stay intact. Sequence-based replay requires the scenario and actions to create messages in the same order.
- admin actions: `addRole` / `removeRole`, for role changes made outside the bot.
- local actions: `closeModal`, `reopenModal` and `dismissMessage`. These change only what the actor sees and dispatch nothing. Dismissals record the message creation sequence, so identical message text does not redirect a replay to a different message.

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

`replay(project, checkpoint)` or `replay(project, log, arrival)` starts a fresh session, repeats the actions, compares each outcome, and checks the arrival conditions. Logs and checkpoints record both the selected scenario version and the shared setup version. Replay rejects a missing or changed preparation before starting the bot. Changing shared setup versions therefore requires recording fresh checkpoints. Replay repeats actions; it never restores promises or collectors, so component and modal IDs must stay stable between runs.

`exportTest(checkpoint, { format: 'vitest' | 'node', projectModule })` generates a test that replays the checkpoint. A checkpoint without arrival conditions exports a failing test that asks you to add one.

A checkpoint contains actions, expected outcomes and preparation references. It does not serialize callbacks, a database snapshot or the implementation of the preparation. After review, discard temporary preview preparation unless the journey earns a maintained regression. To keep a regression:

1. Keep the required extension beside the test, importing the shared project. Preserve its ID/version and any world/seed/actor hooks the journey needs.
2. Export against that fixture, not the temporary PR module: `exportTest(checkpoint, { format: 'vitest', projectModule: './fixtures/locked-channel.js' })`. The module path resolves from the generated test. The host can choose it with `--export-module`.
3. Run the exported test against the fixture, then remove the temporary preview entry point. The shared project needs no permanent catalogue entry for this regression.

Keep file assets as described below when a journey downloads attachments. Maintain the preparation and assertions together; exporting actions alone cannot make a deleted fixture replayable.

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

## PR recipes and automatic previews

A PR can configure the maintained project without adding a scenario module to the repository. Put one named JSON fence inside a collapsed section at the bottom of the description:

````md
<details>
<summary>Scenario Requirements</summary>

```json slipher-lab
{
  "scenario": { "id": "workspace", "version": 1 },
  "params": { "botCanManageRoles": false }
}
```

</details>
````

The JSON uses the existing `Preset` contract: `scenario` can select the shared setup itself or a declared extension; `params`, `services`, `refs` and an explicit shared `setup` reference are optional. Only the `json slipher-lab` fence is configuration. Other code blocks, including documentation examples containing this fence, are ignored. Missing recipes run `project.setup`; malformed, duplicate or incompatible recipes fail instead of silently running the defaults.

The host accepts an immutable PR snapshot, paired with the code you built:

```sh
gh pr view "$PR_URL" --json body,headRefOid > /tmp/lab-pr.json
slipher-lab --project dist/lab/project.js --pr /tmp/lab-pr.json \
  --build-revision "$(git rev-parse HEAD)"
```

The snapshot is read once. Its head must equal the build revision, and the browser starts with the captured parameters and service choices. Checkpoints contain the session's actual preset and the code revision; replay and exported tests use those values, without fetching the PR description again. Programmatic hosts can pass `pullRequest: { body, headRefOid }` alongside `build: { revision }`.

### Configure hosting once

Install `@slipher/lab` and `@slipher/lab-ui` in the bot project and keep its shared preparation in `lab/project.ts`. Then run:

```sh
slipher-lab init
```

The initializer asks for the bot directory, compiled project path, install/build commands, preview domain and either **Dokploy** or **SSH**. It creates `lab.preview.json` and `.github/workflows/lab-preview.yml`, refusing to overwrite existing files. It does not infer guilds, actors or database fixtures from the bot: those remain in the maintained lab project. The generated image uses Node 24 and Corepack; custom install/build commands must work in that Linux environment.

A non-interactive setup for a Docker server looks like:

```sh
slipher-lab init --provider ssh --ssh-host deploy@your-server \
  --domain previews.example.com --project dist/lab/project.js
```

For Dokploy, use `--provider dokploy --dokploy-url https://dokploy.example.com --environment-id <id>`. Add `--server-id <id>` when the Dokploy destination is a remote deployment server.

For a monorepo, `cwd` selects the bot directory inside the repository and `project` is relative to that directory. Install/build commands run from the repository root. Scope a monorepo install to the bot and its dependencies when unrelated packages need additional system tools. For this repository, use `pnpm install --frozen-lockfile --filter lab-bot... --filter seyfert` and `pnpm turbo build --filter lab-bot...`.

Configure a wildcard DNS record for the preview domain pointing at the server. On a **dedicated Docker server** with ports 80 and 443 available, `slipher-lab preview setup` installs a shared Traefik proxy once. Each preview gets its own Compose project and data volume. If the server already has Traefik, configure `provider.proxyNetwork` and `provider.certificateResolver` to use it instead of running setup. Dokploy manages the domain and HTTPS itself.

GitHub configuration:

| Setting | Used for |
| --- | --- |
| Secret `LAB_PREVIEW_PASSWORD` | Browser HTTP Basic login, username `lab` |
| Variable `LAB_REGISTRY_USERNAME` and secret `LAB_REGISTRY_TOKEN` | Pulling private images from GHCR; use a durable account/token with access to the image package |
| Secret `LAB_DOKPLOY_KEY` | Dokploy API access, for that provider |
| Secrets `LAB_SSH_KEY` and `LAB_SSH_KNOWN_HOSTS` | SSH key and verified server host-key entry, for that provider |
| Optional secret `LAB_PREVIEW_ENV` | JSON object of bot service credentials; only names listed in configuration `childEnv` reach the bot |

For example, set `childEnv: ["DATABASE_URL"]` in `lab.preview.json` and provide `LAB_PREVIEW_ENV` as `{"DATABASE_URL":"…"}`. The project's resource hooks must create and clean isolated test data; deleting a preview does not delete an external database. Provider credentials stay outside the bot process. Deployment environment values travel as base64 JSON so quotes, dollar signs and multiline values survive provider serialization.

Commit the generated setup to the base branch before using it on feature PRs. The workflow installs and builds the base branch's controller, uses its configuration, captures the current PR description and exact head, builds an image, validates the recipe against the compiled project, and deploys by image digest. It publishes a GitHub deployment link only when `/api/host` reports that commit and workflow run. Description edits also trigger a build. The saved recipe is available as a CI artifact.

Closing or merging a PR removes the owned Dokploy application or Compose project/volume and marks its GitHub deployment inactive. Repeated cleanup is safe, and delayed closed events skip cleanup if the PR has been reopened. Repository ID and PR number identify a preview across commits; resources with a conflicting ownership marker are refused. The default workflow serves same-repository PRs, serializes their lifecycle events, and rejects a stale head or a closed PR before deployment. Fork previews are not enabled by this template.

Previews, uploaded files and checkpoints are temporary. Export a useful regression before closing the PR. For a parameter-only recipe, its test can import the shared project directly; keep a custom preparation module only when the regression needs additional hooks.

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


Modal files selected in the host UI are uploaded as binary data to the lab host (up to 25 MiB per file). The bot receives a normal HTTP attachment URL and can download the original bytes. Files are kept in `files/` beside the run's checkpoint JSON, rather than embedded in actions. Keep that directory with local checkpoints; replay resolves URLs against the current host, including after a port change. Hosted files expire with their run and are deleted by the existing run cleanup. Download URLs are random capabilities, so a bot does not need the browser's session cookie. Exported tests that fetch these URLs require the host and its files to remain available. The static reference preview demonstrates metadata only.
