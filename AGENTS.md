# Developing Slipher

This is a pnpm workspace (`packages/*` and `examples/*`) managed with Turborepo. The root
scripts run `turbo` across packages; the repository requires Node `>=22.13`
and pnpm `11.11.0`. Preserve unrelated dirty work, inspect the affected
package's source, exports, scripts, README and tests before editing, and match
its existing module and formatting conventions.

## Package ownership

Each package owns its implementation in `packages/<name>/src` and its public
README and `package.json`. TypeScript packages normally compile declarations
and JavaScript to `packages/<name>/lib`; `lib` is generated output. Never edit
generated files by hand or include them as source changes. The macros package
has a checked-in CommonJS implementation and a build script that also compiles
the pinned `packages/macros/vendor/ts-macros` submodule; inspect that script
before changing its build or distribution behavior.

Trace a public change from implementation through package exports and direct
consumers. Keep runtime and declaration behavior aligned. For compiler,
tsserver, CLI, or emitted-code changes, use the existing consumer fixtures and
real process tests instead of relying on a typecheck alone.

## Documentation contract

Public package changes require both surfaces to be updated together:

- `packages/<package>/README.md`: installation, usage, public API and limitations.
- The matching guide in the `tiramisulabs/seyfert-web` repository. Locate its
  current checkout; do not assume a machine-specific path or worktree.

Official plugins and plugin-like packages use
`content/docs/plugins/official/<package>.mdx`; add a new page to that
directory's `meta.json` and update its index when appropriate. Other packages
may belong in an existing category: `content/docs/testing` for testing,
`content/docs/recipes` for adapters, proxy, watcher and integration recipes,
or `content/docs/learn` for core usage. Inspect nearby pages and the relevant
`meta.json` before choosing a location. Ensure examples compile against the
current exports, required Seyfert version, registry/module setup and actual
availability. A README-only change is incomplete, and unpublished packages or
features must not be presented as released.

Validate the affected web documentation as well as the package. If the web
checkout is unavailable, report that documentation remains pending rather than
silently treating the package README as completion.

## Tests and scripts

Use Vitest for package tests, commonly through the package's
`test/vitest.config.mts`; several packages also run a test-project TypeScript
typecheck first. Prefer focused commands such as
`pnpm --filter <package> build` and `pnpm --filter <package> test`, then widen
checks according to the affected surface. Read scripts before running them:
the workspace and neighboring package `lint`, `format`, and `checkb` scripts
often use Biome's `--write` and mutate files. Clean up only changes caused by
your checks and preserve user work.

Preserve meaningful regression coverage during refactors. Test cleanup must run
after failures, and shared temporary consumers must not depend on test-file
ordering. Use names that explain the operation and split scripts at meaningful
responsibilities rather than adding generic wrappers.

Do not commit, push, publish, change versions, or alter release/workflow
configuration unless explicitly authorized.
