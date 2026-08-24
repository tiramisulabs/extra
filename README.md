# Slipher

Official plugins, adapters, infrastructure, and developer tooling for [Seyfert](https://seyfert.dev).

[![Build, Lint, Format & Publish](https://github.com/tiramisulabs/extra/actions/workflows/check.yml/badge.svg)](https://github.com/tiramisulabs/extra/actions/workflows/check.yml)

This monorepo contains the `@slipher/*` packages maintained alongside Seyfert. Each package is installed independently, so applications only take the runtime and integrations they need.

- [Documentation](https://seyfert.dev/docs/plugins)
- [Seyfert](https://github.com/tiramisulabs/seyfert)
- [Packages on npm](https://www.npmjs.com/search?q=%40slipher)

## Packages

### Application features

| Package | Purpose | Guide |
| --- | --- | --- |
| [`@slipher/cooldown`](./packages/cooldown) | Per-command cooldowns with decorator, middleware, and manager APIs. | [Cooldown](https://seyfert.dev/docs/plugins/official/cooldown) |
| [`@slipher/logger`](./packages/logger) | Request-scoped wide-event logging with pluggable output. | [Logger](https://seyfert.dev/docs/plugins/official/logger) |
| [`@slipher/opentelemetry`](./packages/opentelemetry) | Traces, duration metrics, and gateway health telemetry. | [OpenTelemetry](https://seyfert.dev/docs/plugins/official/opentelemetry) |
| [`@slipher/queues`](./packages/queues) | Typed background jobs backed by the current process or BullMQ/Redis. | [Queues](https://seyfert.dev/docs/plugins/official/queues) |
| [`@slipher/scheduler`](./packages/scheduler) | Cron and interval scheduling backed by the current process or BullMQ/Redis. | [Scheduler](https://seyfert.dev/docs/plugins/official/scheduler) |
| [`@slipher/webhooks`](./packages/webhooks) | Minimal HTTP listener for signed Discord webhook events. | — |

### Voice and media

| Package | Purpose | Guide |
| --- | --- | --- |
| [`@slipher/voice`](./packages/voice) | Discord voice connections, Opus transport, and DAVE encryption. | [Voice](https://seyfert.dev/docs/plugins/official/voice) |
| [`@slipher/player`](./packages/player) | Media sources, transcoding, playback queues, and controls on top of Voice. | [Player](https://seyfert.dev/docs/plugins/official/player) |

### Deployment and adapters

| Package | Purpose | Guide |
| --- | --- | --- |
| [`@slipher/scaler`](./packages/scaler) | Explicit placement and supervision of Seyfert workers across multiple hosts. | [Scaling](https://seyfert.dev/docs/learn/scaling) |
| [`@slipher/proxy`](./packages/proxy) | Single-replica Discord REST egress proxy for multi-process deployments. | — |
| [`@slipher/redis-adapter`](./packages/redis-adapter) | Redis-backed cache adapters, including resource expiration policies. | — |
| [`@slipher/generic-adapter`](./packages/generic-adapter) | Fetch-compatible HTTP server adapter for interaction endpoints. | [Cloudflare Workers](https://seyfert.dev/docs/recipes/cloudflare-workers) |
| [`@slipher/uws-adapter`](./packages/uws-adapter) | HTTP server adapter backed by uWebSockets.js. | — |

### Testing and development

| Package | Purpose | Guide |
| --- | --- | --- |
| [`@slipher/testing`](./packages/testing) | Runner-agnostic fixtures and an in-process mock bot. | [Testing](https://seyfert.dev/docs/testing) |
| [`@slipher/eslint-plugin`](./packages/eslint-plugin) | Type-aware ESLint rules for Seyfert applications. | [ESLint](https://seyfert.dev/docs/recipes/eslint) |
| [`@slipher/watcher`](./packages/watcher) | Development hot reload while keeping the gateway process alive. | [Hot reload](https://seyfert.dev/docs/recipes/hot-reload) |
| [`@slipher/chartjs`](./packages/chartjs) | Render Chart.js configurations to image buffers with `@napi-rs/canvas`. | [Chart.js](https://seyfert.dev/docs/plugins/official/chartjs) |

## Using Slipher

Slipher is not installed as a single bundle. Add only the packages your application needs:

```sh
pnpm add @slipher/cooldown
```

Every package is versioned independently and declares its own Seyfert, runtime, and optional integration requirements.

## Working in the repository

The workspace targets Node.js 22.13 or newer and pins pnpm 11.11.0. Install pnpm through one of its [supported installation methods](https://pnpm.io/installation), then:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs formatting, linting, builds, tests, and Biome checks across the workspace. The Redis-backed suites expect Redis 8 to be available at `127.0.0.1:6379` unless their environment overrides the connection URL.

Useful workspace commands:

| Command | Action |
| --- | --- |
| `pnpm build` | Build every package. |
| `pnpm test` | Run package test suites. |
| `pnpm lint` | Run repository lint tasks. |
| `pnpm format` | Apply repository formatting. |
| `pnpm check` | Run the complete local verification pipeline. |

To work on one package, use pnpm filtering:

```sh
pnpm --filter @slipher/queues test
pnpm --filter @slipher/queues build
```

## Documentation ownership

Package READMEs provide installation, a current quick start, compatibility requirements, and important operational warnings. Exhaustive guides live in [`tiramisulabs/seyfert-web`](https://github.com/tiramisulabs/seyfert-web) and are published on [seyfert.dev](https://seyfert.dev), so contracts, examples, and architecture have one canonical home.

When a package change affects its canonical guide, open a sibling PR in `seyfert-web` and link the two PRs in both directions. Keep README examples small enough to verify against the current public API.
