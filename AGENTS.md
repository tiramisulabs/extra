# Developing Slipher

Only what reading the manifests, configs and workflows does not already tell you.

## Documentation ownership

The rule is the "Documentation ownership" section of the root `README.md`.

- A package `README.md` provides installation, a current quick start, compatibility requirements and important operational warnings. Most existing ones are under 60 lines.
- Anything exhaustive (contracts, full examples, architecture) is a guide. Guides live in [`tiramisulabs/seyfert-web`](https://github.com/tiramisulabs/seyfert-web) and are published on seyfert.dev. Do not write them in this repository.
- When a package change affects its guide, open a sibling PR in `seyfert-web` and link the two PRs in both directions.
- Keep README examples small enough to verify against the current public API.
- Every package has a row in the root `README.md` package table: package, purpose, and guide link or `—`. Add or update the row together with the package.

## What a push does

Every push, to any branch or tag, runs `check.yml`:

- It formats and lints in write mode, commits whatever changed (`git add -A`) as `chore: apply formatting`, and pushes that commit to the ref you pushed. Fetch before you push again.
- It publishes a pkg.pr.new preview of every package under `packages/` that is not `"private": true`.

Two other workflows publish to npm:

| Trigger | Effect |
| --- | --- |
| Push to `main` that touches `packages/*/src/**` | Each touched package is published under the `dev` tag as a `dev-<run id>` prerelease. Nothing is committed back. |
| Push to `build` | Every package whose `version` is not on npm yet is published, including a package that has never been released. |

Tags release nothing. A `version` edit is a release as soon as it reaches `build`, so do not change one as a side effect of other work.

## Tests

Run a package from the root: `pnpm test --filter=@slipher/<name>` builds its dependencies and typechecks before testing. The package's own `test` script does neither, and resolves sibling `@slipher/*` imports to whatever those packages last built into their gitignored `lib/`.

- Turbo filters the environment. A variable a suite reads must be listed under `tasks.test.env` in `turbo.json`, or it is dropped in the root run and in CI.
- `typecheck` is narrower and stricter than the runtime:
  - It compiles only what the package's `test/tsconfig.json` includes: just `test/types.ts` in `cooldown`, `logger`, `proxy` and `queues`, and a hand-written file list in `scheduler`. Compile-time assertions anywhere else are never checked.
  - Every package compiles to CommonJS and test tsconfigs inherit it. `import.meta` and top-level `await` pass at runtime but fail `typecheck`, unless the package's `test/tsconfig.json` sets `module: ESNext` as `voice` and `player` do. In `src/` they never compile.
- Outside the root run, so never in CI: `test:types` and `test:integration` in `scaler`, `test:stress` in `proxy`.
- The transcoding test in `player` skips when `ffmpeg` is not on `PATH`.

Redis-backed suites:

| Suite | Runs | Connects to |
| --- | --- | --- |
| `redis-adapter` (all), `cache-integrity/test/redis.test.mts`, `cooldown/test/manager.test.mts` | Always | `SLIPHER_REDIS_URL`, default `redis://127.0.0.1:6379` |
| `queues/test/redis-integration.test.mts` | Only with `SLIPHER_REDIS_PORT` or `CI` set | `127.0.0.1` on that port, `6379` under `CI` |
| `scheduler/test/redis-smoke.test.mts` | Only with `SLIPHER_SCHEDULER_REDIS_URL` set | That URL |

The last two skip silently: a green local run has not touched Redis unless you exported the variable. CI runs Redis 8.0 on `127.0.0.1:6379` and sets only `SLIPHER_SCHEDULER_REDIS_URL`.

## Line endings

TypeScript is CRLF (`biome.json`): an LF source file comes back fully rewritten in the formatting commit. Markdown is LF in every tracked file, although `.editorconfig` declares CRLF for nearly all of it. Keep Markdown LF.

## Commits and pull requests

Conventional Commits, scoped by package directory: `fix(scheduler): …`, no scope for a change across packages, `!` for a breaking one. Give the PR title the same form: most PRs are squash-merged, and the title becomes the commit subject.
