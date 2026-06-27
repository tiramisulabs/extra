# `@slipher/testing` — design to make every Seyfert bot and plugin testable

Goal: the best testing library for small **and** big Seyfert bots — **simple, ergonomic, powerful**.
Validated across multiple agent panels reading the real source. File:line citations are in
`packages/testing/src` and the sibling plugin packages.

---

## 0. Guiding principles

1. **Two altitudes, one import — keep both, headline the bot.**
   - `createMockBot` (integration): boots a real Seyfert `Client` with mock REST/gateway and runs the
     **real pipeline** (`client.handleCommand.interaction`, `bot/bot.ts:1767`). No cast, full fidelity.
   - `mockCommandContext` / `mockComponentContext` / `mockModalContext` (unit): a plain object, `ctx.run(cmd)`
     calls the body directly (`context.ts:292`). Fast, no boot, no I/O.
   - **Do not collapse into a fake `bot.run`.** The mock bot has no context-injection seam — it dispatches
     payloads and Seyfert builds the context internally. A "fast path on the real client" would re-fabricate
     the `as never` cast and add timer/teardown cost. Verified (`bot/bot.ts:1767`).
   - Decision rule (already in README:8): *pure `run()` logic → fixtures; anything touching the pipeline,
     plugins, components, REST, events, time → mock bot.*

2. **Simple by default, powerful on demand.** Zero-config first test; opt into world/plugins/clock as needed.

3. **The package owns Seyfert surface; the app owns its domain.** DB documents (papr) and app singletons
   (`sendLog`, airtable, leaderboard) are **app-side** — the package ships generic *recipes*, not code for them.

---

## 1. Current state — already a strong base

`createMockBot` covers almost the entire Seyfert interaction surface through the real pipeline:

| Surface | Today | Method (`src/bot/`) |
|---|---|---|
| Slash + options | ✅ | `slash()` `bot.ts:1961`; encoders `interactions.ts:62-178` |
| Subcommands & groups | ✅ | `chatInputInteraction` `interactions.ts:303-309` |
| User/Message context menus | ✅ | `userMenu`/`messageMenu` `bot.ts:2012-2020` |
| Autocomplete | ✅ | `autocomplete()` `bot.ts:1983` (`result.choices`) |
| Buttons | ✅ | `clickButton()` `bot.ts:2064` |
| All select menus (string/user/role/channel/mentionable) | ✅ | `selectMenu()` `bot.ts:2094`; resolved from world |
| Modals (submit + fields) | ✅ | `fillModal()` `bot.ts:2126` |
| Component collectors + timeout | ✅ | hooks `hooks.ts:89-96`; `advanceTime` `bot.ts:1522` |
| Replies (`write`/`editOrReply`/`followup`/`update`/`defer*`) | ✅ | captured `bot.ts:1845-1893` |
| REST side-effects | ✅ | `findAction`/`waitForAction` `bot.ts:1306-1332`; recorder `rest.ts:824` |
| Permissions / bot-permissions denials | ✅ | `hooks.ts:231-259`; world-derived `bot.ts:825-915` |
| Middlewares (global + per-cmd) + stop/pass/deny | ✅ | `hooks.ts:152-223` |
| `onRunError` | ✅ | `result.error` `bot.ts:2463-2479` |
| i18n / locales | ⚠️ | wires `langs`/`defaultLang` `bot.ts:614-617` + per-dispatch `locale` — but pluralization/interpolation/fallback are Seyfert's runtime; no assertion helper |
| World/cache seeding + query + diff | ✅ | `world` `bot.ts:574`; `worldSnapshot`/`worldDiff` `bot.ts:1412-1423` |
| Events (`bot.emit`, gateway + custom) | ✅ | `emit()` `bot.ts:2219`; world bridge `world-events.ts:10-24` |
| **Bot using plugins** (cooldown-as-mw/queues/logger/3rd-party) | ✅ | `plugins` `bot.ts:605`; lifecycle `bot.ts:124-144`; `bot.plugins` `bot.ts:1254` |

The fixtures layer adds the fast unit path: `mockCommandContext()` is zero-config and fabricates
author/guild/channel/client/logger/queues/scheduler (`context.ts:230-296`); `ctx.run(cmd)` now accepts a
command of **any `run` arity** (just fixed, `context.ts:73`).

**Verdict: a bot's command/component/modal/event/permission/i18n/world behavior is already testable today.**
The work below closes the remaining gaps so *every* bot and *every* plugin — including time-driven and
service-coupled behavior — is testable.

---

## 2. Gaps blocking "every bot + plugin testable"

| Gap | Severity | Evidence |
|---|---|---|
| **G1. No bot-owned clock.** `advanceTime` only drives faked `setTimeout`; `Date.now()`-based code (cooldown `manager.ts:145`, `mockId({age})` `id.ts:44`) does **not** move. | P0 | `bot.ts:633-639,727,1178` |
| **G2. Service stubs are record-only.** `mockScheduler`/`mockQueues` (`stubs.ts:261-332`) record but cannot be **driven** — you can't fire a scheduled task or process/fail/retry a job. | P0 | `stubs.ts:261-332` vs real `queues/lib/index.js:174-341` |
| **G3. Cooldown is not a plugin & not time-drivable.** `CooldownManager` + `Cooldown()` decorator (`cooldown/src/manager.ts:7`), bare `Date.now()`, no `ctx.cooldown`, no denial kind. | P0 | `cooldown/src/manager.ts:145` |
| **G4. No plugin-author harness.** A plugin author must boot a whole bot to exercise their `setup`/middleware/ctx-augmentation; no `testPlugin`. | P0 | `index.ts`, `stubs.ts` (consumer stubs only) |
| **G5. Fake-timer bridge is hand-rolled & fragile.** Every timed test hand-writes `{ advance: ms => vi.advanceTimersByTime(ms) }` + exact `toFake`; wrong config silently deadlocks. | P1 | README:490-516; `bot.ts:707` |
| **G7. No event payload factories.** Event tests hand-build raw gateway shapes; cache-staleness footgun. | P1 | README:817; `bot.ts:2188-2195` |
| **G8. Message & reaction collectors not driven.** Only component collectors resolve; `awaitMessages`/reaction collectors can't be exercised. | P1 | grep empty in `src/`; `bot.ts:983` |
| **G9. `onInternalError` not captured; no cooldown denial kind.** | P1 | matrix ⚠️ rows |
| **G10. Gateway lifecycle is record-only.** No inbound packet dispatch / resume / reconnect state machine, so infra/shard handlers can't be tested. | P2 | `gateway.ts`; README:789 |
| **G11. DB document & app-singleton boilerplate.** 40% of one bot's tests `vi.mock` app singletons; verbose papr-doc seeding. | docs | app-scope |
| **G12. Pagination state across N collector clicks.** No cumulative live-message view; each click returns a fresh `DispatchResult`. | P1 | adversarial H1; `bot.ts:229` |
| **G13. Collector `filter`/`onPass` never executed.** Synthetic clicks bypass the predicate — button-hijack guards untestable. | P1 | `bot.ts:933` |
| **G14. No embed reader coverage.** Assert via raw `reply.body.data.embeds[0]`. | P1 | rendered-output reader |
| ~~G14b~~ **Verified handled** (not a package gap). Collector on a modal-submit reply works with `fetchReply` — regression-locked. Reported wall = missing `fetchReply` (Seyfert throws, production-faithful) / old build / wrong explicit source. | done | `test/bot/clippy-collector.test.mts` |
| **G15. Sharding / cross-shard routing not modeled.** | P2 | `gateway.ts`; README:789 |
| **G16. Scheduler package absent in tree** (only `origin/socram/slipher-scheduler`); its stub must be re-derived from real source when it lands. | gate | only `mockScheduler` stub exists |

---

## 3. Changes & additions

### P0 — unblock time, services, and plugins (the "every plugin" bar)

#### A. Time is the runner's job — the package owns no clock

Decision (after weighing long-term risk): **@slipher/testing does NOT shim a global `Date.now` or own a
virtual clock.** Owning/monkeypatching global time is a classic flakiness source — leakage across tests if not
restored, parallel-bot contention, `new Date()` vs `Date.now()` gaps, conflicts with the runner's own fake
timers, ongoing maintenance. Time control belongs to the **test runner**.

What stays (already exists, not new): `bot.advanceTime(ms)` (`bot.ts:1522`) forwards to the user-provided
`timers.advance` callback — the runner's fake `setTimeout`. That already drives **collector/modal `setTimeout`
timeouts** (the common case). For `Date.now()`-relative behavior (cooldown windows, queue retry-after-delay),
the user drives time with `vi.useFakeTimers()` + `vi.setSystemTime()` directly — a **documented recipe, not a
package feature**. Wherever the package can drive behavior **without** time (explicit `process()`/`runNext()`/
`trigger()` — see B), it does; only genuinely time-relative cases lean on the runner.

#### B. Drivable services (fixes G2) — **two layers, not one mechanism**

Adversarial review caught a layer confusion: `mockScheduler`/`mockQueues` (`stubs.ts:261-332`) are **fixture
stubs** used by `mockCommandContext`; but on the **mock-bot path** `bot.client.queues` is the **real** queues
plugin (loaded via `plugins:[…]`), *not* the stub. "Drivable" therefore splits cleanly, and the doc must keep
them separate to avoid maintaining a divergent parallel queue implementation:

**(i) Real-plugin path (preferred for integration) — drive the REAL plugin with the bot clock.**
The real `MemoryQueue` fires delayed/retry jobs via `setTimeout` (`queues/lib/index.js:273-274`) and reads time
via `this.now` defaulting to `Date.now` (`:149`). Because the global `Date.now` shim (A) moves with
`advanceTime` (and the fake `setTimeout` moves too), the real plugin is driven **with no explicit clock
injection** — which also avoids the `bot`-before-`bot` chicken-and-egg of passing `() => bot.now()` into the
driver at construction:

```ts
await using bot = await createMockBot({ plugins: [queues({ driver: memory() })] }); // real plugin
const q = bot.client.queues.get('emails');
q.process(async job => { if (job.attemptsMade < 2) throw new Error('smtp'); });
await q.add('send', { to: 'a' }, { attempts: 3, retryDelay: '5s' });
await bot.advanceTime('5s');     // shimmed Date.now + fake setTimeout both move -> retry fires
expect(q.events).toContainEqual(expect.objectContaining({ type: 'retrying' }));
```

(A is what makes this work — `memory()`'s default `Date.now` is the shimmed one. Optional `bot.drainQueues()`
convenience; do **not** reintroduce a `() => bot.now()` thunk that references `bot` before it exists.)

**(ii) Fixtures path (unit) — make the record-only stubs drivable.**
For `mockCommandContext` tests (no bot), give the stubs explicit driver methods, with event names mirroring the
real plugins (`added/active/completed/failed/retrying/idle`, `queues/lib/index.js:174-341`) so assertions
transfer:

```ts
// scheduler — drive a scheduled task
const sched = mockScheduler();
sched.add('digest', '30m', run);
await bot.advanceTime('30m');     // fires due tasks via the bot clock
// or explicit: await sched.trigger('digest');
expect(run).toHaveBeenCalledOnce();

// queues — process, fail, retry against the clock
const q = bot.client.queues.get('emails');
q.process(async job => { if (job.attemptsMade < 2) throw new Error('smtp'); });
await q.add('send', { to: 'a' }, { attempts: 3, retryDelay: '5s' });
await q.runNext();                // attempt 1 fails -> 'retrying'
await bot.advanceTime('5s');      // retry fires -> 'completed'
expect(q.events).toContainEqual(expect.objectContaining({ type: 'retrying' }));
expect(q.completed).toHaveLength(1);
```

New stub API: `mockScheduler.trigger(id)` / `tick(ms)`; `mockQueues.get(name).process(fn)` / `runNext()` /
`fail(name)` / `events` — mirroring `queues/lib/index.js:174-341` (`added/active/completed/failed/retrying/idle`).

#### C. Plugin testing — `testPlugin()` + cooldown made testable (fixes G3, G4)

**Plugin author harness** — exercise a plugin in isolation without authoring a fake bot:

```ts
import { testPlugin } from '@slipher/testing';

const h = await testPlugin(logger());
expect(h.contributions.ctxKeys).toContain('logger');   // PluginDiagnostics snapshot
const ctx = h.ctx({ command: 'ping' });
ctx.logger.info('hit');

// middleware-style plugin: drive its middleware directly
const denial = await h.runMiddleware('rateLimit', h.ctx());
expect(denial).toMatchObject({ kind: 'stop' });

await h.teardown();
expect(h.teardownRan).toBe(true);
```

`testPlugin(plugin, opts?)` = `createMockBot({ plugins:[plugin] })` + a `contributions` snapshot
(`bot.plugins`/`PluginDiagnostics`, `bot.ts:1254`) + `ctx()`/`runMiddleware()` shortcuts. Feasibility-confirmed:
it reads the existing `bot.plugins` getter and mints a `ctx` by dispatching an **internal no-op command** it
registers (the bot has no context-injection seam, so a real dispatch is how you get a real ctx). Caveats to
document, not hide:
- **Single-plugin isolation.** `testPlugin(p)` tests one plugin. Composition / ordering / cross-plugin deps
  (e.g. logger reading queues) → use `createMockBot({ plugins:[a, b] })`; order is observable via
  `bot.plugins[].middlewares`. Don't overclaim isolation here.
- **Pre-`setup` I/O.** `setupPlugins()` is awaited at construction (`bot.ts:128`). A plugin whose `setup`
  connects to a DB/socket must be constructed with a fake driver (the established pattern —
  `queues({ driver: memory() })`); there is no post-construction seam for `setup`-time deps. Document this; it
  is not a `testPlugin` affordance.
- Event-handler plugins, client-augmentation, and teardown **are** covered (`emit` runs plugin listeners,
  `bot.ts:2361-2366`; `bot.client.queues` reads the client key; `h.teardownRan` checks `client.close()` teardown,
  `bot.ts:2411`).

**Cooldown — commit to shipping the middleware (today it is neither a plugin nor wired into dispatch).**
`@slipher/cooldown` exports only `CooldownManager` + a `Cooldown()` **class decorator** (`cooldown/src/index.ts`);
it registers **no middleware**, so `bot.slash(Cmd)` will **not** produce a cooldown denial on its own — nothing
in the pipeline calls `manager.context()`. So the additions must include an actual cooldown **middleware/plugin**
(or a `mockCooldown(bot)` that installs one) that (a) reads the `Cooldown()` decorator metadata via
`manager.getCommandData` (`cooldown/src/manager.ts:18`) and (b) reads the **bot clock** — which requires the
global `Date.now` shim (A), since `manager.ts:145` and `resource.ts:24` both read bare `Date.now()` and are not
injectable today. With that shipped:

```ts
await bot.slash(BanCommand, { options });                // 1st: ok
const denied = await bot.slash(BanCommand, { options });  // 2nd: cooled down
expect(denied.denial).toMatchObject({ kind: 'cooldown', retryAfter: expect.any(Number) });
await bot.advanceTime('1m');                              // window passes (A moves global Date.now())
await bot.slash(BanCommand, { options });                 // ok again
```

Requires: a cooldown middleware/plugin (new), `result.denial.kind: 'cooldown'`, a `bot.cooldown(command, user)`
state accessor, and the global `Date.now` shim from A. **Decision: ship the cooldown plugin/middleware** rather
than the bare-manager `mockCooldown` — it makes the decorator path testable through the real pipeline and serves
real bots, not just tests.

### P1 — ergonomics & coverage

#### D. `mockClock()` runner adapter (fixes G5)

```ts
import { createMockBot, mockClock } from '@slipher/testing';
const bot = await createMockBot({ commands: [Poll], timers: mockClock() }); // vitest/jest auto-detected
await bot.advanceTime('15s'); // collector timeout fires; no hand-wired { advance }
```

Ships the exact `{ advance }` shape `createMockBot({ timers })` expects (`bot.ts:633`), with vitest & jest
variants — eliminating the one bit of boilerplate the README spends a whole section on (README:490-516).

#### F. Event payload factories + message/reaction collectors (fixes G7, G8)

- `gatewayMemberAdd(member)`, `gatewayMessage(...)`, etc. — emit cache-complete gateway shapes from world
  entities, so `bot.emit('GUILD_MEMBER_ADD', gatewayMemberAdd(m))` doesn't go stale (README:817 footgun).
- Route emitted `MESSAGE_CREATE`/reaction payloads into active message/reaction collector runtimes, with
  `advanceTime` driving their idle/timeout — so `awaitMessages`/reaction flows are testable. **Note:** unlike
  component collectors (which already have detection machinery at `bot.ts:983`), message/reaction collector
  runtimes are **net-new** — higher effort than the component path; size Phase 2 accordingly.

#### F2. Collector fidelity + pagination + embed assertions (fixes new H1, H2, A1 from adversarial review)

Three holes the first draft missed; common enough to be P1:

- **Run the collector `filter`/`onPass` predicate.** Today the synthetic click never invokes `filter`
  (`bot.ts:933` literally notes *"filter(context) is only noted, never invoked"*). A button-hijack guard
  (`filter: i => i.user.id === opener`) is therefore **untestable** — a real security pattern. Fix: build a
  live component context for `clickButton`/`selectMenu` and actually run `filter`/`onPass` before resolving,
  surfacing a `filtered` outcome.
  ```ts
  const r = await bot.clickButton('confirm', { user: someoneElse });
  expect(r.filtered).toBe(true);     // hijack rejected by the command's filter
  ```
- **Live cumulative message view for pagination.** Multi-step collector flows (page 1→5, each editing the same
  message) currently return a fresh `DispatchResult` per click; there's no "what does the message look like
  after click 3?". Add `bot.message(id)` (or `r.message`) that folds `edits` across dispatches so pagination is
  assertable without threading message ids by hand. Ship a worked pagination example.
- **Embed/content readers.** Attachments/files are covered, but embeds are often asserted by indexing
  `reply.body.data.embeds[0].title`. Prefer typed rendered-output readers over ad hoc raw-payload indexing.
- **Collector on a modal-submit reply — VERIFIED HANDLED, not a package gap.** Investigated the reported
  end-to-end wall with a repro: a `ModalCommand` replying via `ctx.editOrReply(body, true)` then
  `message.createComponentCollector().run('continue', …)`, driven by `bot.fillModal(...)` +
  `bot.clickButton('continue')`, **works on current code** — the modal reply's `@original` is materialized under
  its token (type-4 callback `defaults.ts:525-530` → `bot.ts:1581-1583`), so `clickButton` resolves the source
  with no explicit `source`. **Locked by a regression test** in `test/bot/clippy-collector.test.mts`. The
  reported wall was one of: (a) the handler omitted `fetchReply` (`editOrReply(body)` returns void → **Seyfert
  itself** throws on `.createComponentCollector()`, production-faithful — not a mock bug), (b) an older
  pkg.pr.new build predating the modal-token materialization, or (c) passing the wrong explicit `source` (the
  callback action, which legitimately has no message id, `bot.ts:1147`). **No code fix warranted** — confirmed
  by a passing repro; don't change materialization without a failing test.

#### G. Close the error & cooldown denial gaps (fixes G9)

Capture Seyfert's `onInternalError` into `DispatchResult` symmetric to `onRunError` (`bot.ts:2463`); add the
`cooldown` denial kind (C).

### P2 — power for infra

#### H. Gateway lifecycle + sharding (fixes G10, new H4)

Extend `MockGateway` beyond recording: inbound packet dispatch (`READY`/`RESUMED`/`HELLO`), heartbeat-ack /
sequence tracking, and a connect→disconnect→resume state machine, plus `bot.emitRaw(packet)` — so reconnection
/ session-resume / raw-packet handlers can be tested. **Sharding (new H4):** add a guild→shardId routing model
and per-shard `READY`, so cross-shard logic (`client.gateway.send` to a specific shard for a guild) is assertable
beyond the raw `sent` array. Big-bot-only; honestly a known limitation until this lands.

### Docs (fixes G11 + repositioning)

- **Reposition README:** lead with `createMockBot` as the default; present fixtures as the explicit fast unit
  path with the one-line decision rule. Add a "which tool when" table.
- **DB documents are app-side:** document the factory recipe (mirror `mockUser`, reuse `mockId` for
  deterministic, `resetMockIds`-aware ids) — no package code.
- **Plugin testing guide** (C).
- Per-plugin time-testing examples (cooldown window, scheduled task, queue retry).

---

## 4. Final public API (`index.ts`)

Replace the 5 bare `export *` with explicit, grouped re-exports that encode the headline ordering:

```ts
// Core entrypoints (headlined: integration first)
export { createMockBot, MockBot, mockWorld, WorldBuilder } from './bot';
export { mockCommandContext, mockComponentContext, mockModalContext } from './context'; // fast unit path

// Factories (feed both layers)
export { mockUser, mockGuild, mockChannel, mockMember } from './factories';
export { apiUser, apiGuild, apiRole, apiChannel, userOption, channelOption, /* … */ } from './bot';
export { gatewayMemberAdd, gatewayMessage, /* … */ } from './bot';   // NEW (F)

// Service stubs (bridge Slipher services) — now drivable (B)
export { mockLogger, mockQueues, mockScheduler, mockClient } from './stubs';

// Id / time
export { mockId, timestampFrom, idAge, resetMockIds, mockTimestamp } from './id';
export { mockClock } from './bot';            // NEW (D)
export type { DurationInput } from './id';    // NEW (re-export so `age` typing needs no @slipher/internal)

// Plugin testing
export { testPlugin } from './plugin';        // NEW (C)
export { mockCooldown } from './cooldown';    // NEW (C) — until/if cooldown ships a real plugin

// Dispatch / REST / world-query / outcome / gateway
export { Routes, DiscordErrors, apiError, permissionBits } from './bot';
export { outcome, OutcomeError } from './outcome';
export { MockGateway } from './bot';

// Types (intentional contracts)
export type { /* Mock*Options, DispatchResult, RecordedAction, WorldState*, PluginHarness, … */ };
```

Nothing is removed (0.x but publicly shipped). Keep `createMockBot` (verb-y constructor, the headline) even
though it breaks the `mock*` prefix — justified by altitude.

### "Which tool when"

| Testing… | Use |
|---|---|
| A pure `run()` body (no parsing/mw) | `mockCommandContext` + `ctx.run(cmd)` |
| Parsing, middlewares, permissions, components, REST, events, i18n, **plugins**, **time** | `createMockBot` |
| A component/modal in isolation | `mockComponentContext` / `mockModalContext` |
| A plugin's `setup`/middleware/ctx in isolation | `testPlugin(plugin)` |
| Time-driven behavior (cooldown/scheduler/queue/collector) | `createMockBot` + `bot.advanceTime` |

---

## 5. Coverage after the changes — every bot & every plugin

**Every bot:** all interaction types (slash/sub/menu/autocomplete/buttons/all-selects/modals); component +
**message + reaction collectors** with **`filter`/`onPass` actually run** and **pagination state** assertable
(F2); all reply/defer variants + **embed matchers** (F2); REST side-effects + error/429/50013 paths;
permissions; middlewares; `onRunError` + `onInternalError` (G); world/cache; events (`emit` + payload
factories); and **time-driven behavior** via the bot clock (A). Honest caveats: i18n is tested at the
wiring/locale level (interpolation/pluralization are Seyfert's runtime — no helper); infra **sharding/gateway
lifecycle is P2** (big-bot-only). Intentionally out: app domain (DB docs, imported
singletons) — documented recipes (DB-doc factory like `mockUser`; read services off `ctx.client` instead of
importing singletons). The package ships no `services` injection option — app concern, kept out as overkill.

**Every plugin:**
- *Bot using a plugin* → `createMockBot({ plugins })` runs the real plugin lifecycle (`bot.ts:124-144`).
- *Plugin author* → `testPlugin(plugin)` exercises `setup`/teardown/middleware/ctx-augmentation in isolation.
- *cooldown* → `mockCooldown` / cooldown denial kind + bot clock.
- *queues* → drivable `mockQueues` (`process`/`runNext`/`fail` + events) and real-plugin path.
- *scheduler* → drivable `mockScheduler` (`trigger`/`tick`) + bot clock.
- *logger* → wide-event capture via the plugin path (`logger/lib/plugin.d.ts:65`).
- *arbitrary 3rd-party* → `testPlugin` + the generic plugin host.

The single foundational item is **the bot-owned clock (A)** — it's what turns cooldown/scheduler/queues from
"record-only" into "drivable", and it's the gate for "every plugin can be tested".

---

## 6. Phasing & stability (0.x — safe to change shape now)

- **Phase 1 (P0):** bot clock (A) → drivable stubs (B) → `testPlugin` + cooldown (C). Unblocks "every plugin".
- **Phase 2 (P1):** `mockClock` (D), event factories + msg/reaction collectors (F),
  collector `filter` + pagination live-message view + embed matchers (F2), error/denial gaps (G),
  the grouped barrel + README reposition.
- **Phase 3 (P2):** gateway lifecycle + sharding routing (H).
- **Gate:** re-derive the scheduler stub from the real package when `origin/socram/slipher-scheduler` lands (G16).

0.x: the barrel shape, `mockClock`, `DurationInput` re-export, and the new options are safe to land now and
should before 1.0. Keep unstable per README:838 (`mockId()` format, warning text, `RecordedAction.seq`,
`MockGateway` internals). Do not promote internal modules (`hooks`, `defaults`, `dispatch*`) — keep the
`bot/index.ts:15-21` allowlist discipline.

### Residual risk

The fixture ↔ mock-bot fork is a real mental-model split with no migration seam (result shapes differ:
`ctx.responses` vs `result.replies`). Mitigated by headlining the bot and the decision rule, but a test that
outgrows fixtures must be rewritten. Accepted: it's the unit-vs-integration boundary, and the ecosystem
(NestJS, Express/supertest) lives with the same split.

---

## 7. Phase 4 — DX & ergonomics (decisions from a 30-domain agent panel)

A 30-expert panel proposed ~90 suggestions; deduped/clustered/ranked. My go/no-go below. **Heavy
convergence (~8 experts) on one item: a single auto-reset/setup helper** — treat it as one deliverable.

### Accepted (GO) — grouped, by phase

**Phase 4a — cheap, high-value, low-risk (do first):**
- **`setupSlipherTesting()`** — one-import bootstrap that auto-`resetMockIds()` (+ clock reset) per test; kills
  the #1 cross-test id-bleed footgun. Runner-agnostic (uses global `beforeEach`).
- **`mockMessage()`** factory + **`mockScene()`** bundle (`{ user, guild, channel, member, ctx }` wired
  consistently) — onboarding + menu targets + collector sources.
- **Fail-loud readers/checks**: action lookup, choice lookup, ephemeral/flag checks, component lookup, no-response
  checks, and denial `reason` checks should all dump actual/"actions seen" instead of green-on-`undefined`.
- **bigint/circular-safe diagnostic formatter** (it crashes on snowflake bigints today — a real bug).
- **`advanceTime(DurationInput | number)`** — fix the doc/impl mismatch (`parseDuration` already imported).
- **`result.explain()` + dispatch-aware failure context** appended by every matcher.
- **Typed `overrides` escape hatch** + **single-source shared defaults** across `mock*`/`api*` factories.

**Phase 4b — medium, high DX leverage:**
- **Fluent nested world builder** (`mockWorld().guild({}, g => { g.role(); g.member({roles:['Mod']}) })`),
  member-centric + role-by-name seeding, `expectWorldChange`/`result.worldDiff`, field-level array deltas,
  scoped snapshot/diff, scenario presets, bulk seeding.
- **Stable snapshot serializers + `toSnapshot()`** (redact id/token/timestamp) — unblocks snapshot testing.
- **Class-first `mockCommandContext(Command)` / `autocomplete(Command)`** inferred options; typed `ctx.replies`
  (`{via, options}`); keyed/typed modal fields; discriminated `MockComponentContext` on `componentType`.
- **Collector/modal fidelity**: `bot.collector(messageId)` live handle (pairs with the G14b modal-source fix),
  collector end-state on result (`{matched, ended, endReason, count}`), select-option fidelity + pick-by-label,
  scoped component lookup (throw on >1), `bot.openedModal()`, `expectModal`/`fillModalIfOpened`, widen
  `fillModal` to `string|string[]`.
- **Permissions**: `bot.can(user, channel, perms)` + layer-by-layer `explain`; `denial.computed`/which-layer.
- **Plugin author**: surface `messages`/`requirements`/`imports` on `PluginInfo`; `testPlugin({expectFailure})`;
  drive contribution seams (`fireRest`/`fireDispatch`/`shared`); expose middleware order.
- **Wide-event capture**: `result.events` via a memory log adapter + rebuild `mockLogger()` around the real
  `WideEventLogger` + `expectEvent`/`expectLogged` (the "wide-event capture" headline has **no** capture surface
  today — important).
- **Queues/scheduler/cooldown**: `fakeCron()` deterministic cron driver (croner reads wall-clock — cron is
  otherwise undrivable; corrects a false claim), state assertions (`queueState`/`scheduledTask`/`expectTask`),
  decorator processor/task harness, `cooldownOf(Command)` reader, token-bucket-aware cooldown state + denial,
  scope-aware cooldown targeting + `refillCooldown`.
- **Events**: handler call recorder (`result.handlers`/`bot.eventLog`), `emittedWorldDiff`, stale-payload guard
  (today a reaction on an unseeded id silently no-ops → green test).
- **i18n**: `bot.t(locale)` + `expectLocalized`, locale aliases, `langs`/`t` on fixtures, `bot.eachLocale()`.
- **REST**: scoped `findAction` on `DispatchResult` (per-dispatch), **MSW-style responder `bot.rest.on(route,
  fn)`** (responder only — see skip list), audit-log `reason` matcher.
- **Time**: `createMockBot({ now })` + `advanceTimeTo(instant)`, `nextTimerIn()`/`advanceToNextTimer()`,
  bot-clock-aware `bot.idAge`/`expectAge`.
- **CI/perf**: `slipherPreset()` vitest fragment, `assertSeyfertVersion()` boot guard, `reset({world:true})`
  per-test reuse, cache `world.build()`.
- **Debug**: per-middleware `result.trace`, `worldDiff` pretty-printer, `bot.dump()` for hung tests.
- **Migration**: spy-backed service stubs, `fromDiscordObject()` adapter, `toApi*` bridge, `mockMenuContext`.

### Skipped (NO-GO) — over-engineering / defer (panel's own skip list + my call)
- `fast-check` arbitraries — niche; not worth the peer-dep/maintenance.
- `createMockBotFactory().spawn()` snapshot/restore boot — defer; `reset({world:true})` + cached `world.build()`
  likely capture most of the gain at a fraction of the complexity.
- MSW **policy matrix** (`onUnhandledRequest` warn/error/bypass tiers) — ship the responder, skip the knobs.
- REST-layer 50013 enforcement tied to world perms — opt-in/later tier, not core.
- `guardNondeterminism` instrumentation — intrusive; the auto-reset helper neutralizes most of the footgun.
- `emit.sequence([...])` — thin once the event recorder + shared-id seeding exist.
- A separate `expect.extend` matcher pack **before** the standalone `OutcomeError` helpers exist — build
  the standalone matchers first; the pack is a thin adapter, not a parallel effort.

### Implemented in this pass (the safe Phase-4a slice)
`setupSlipherTesting()`, `mockMessage()`, and `mockScene()`. The rest is staged above by phase.
