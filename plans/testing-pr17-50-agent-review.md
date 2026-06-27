# PR #17 - @slipher/testing 50-agent review

PR: https://github.com/tiramisulabs/extra/pull/17

Reviewed head: `5a9429f13446296d78955df72c0b8e23028f7eab`

Live PR base: `8208e06df1b1ef79f34fd871f61948d6ef750ef0`

Diff reviewed: `origin/main...refs/pr-review/17` (merge-base is the PR base above)

Date: 2026-06-18

## Method

- Used the requested `improve` and `review` skills.
- Spawned exactly 50 successful read-only agents. Failed spawn attempts caused by the concurrency limit were not counted.
- Did not use local markdown as source context because the user said it is outdated.
- Used code, package config, tests, and the live PR metadata/body/spec.
- No source code was changed. No commit and no push.
- No build/test/lint was run by the main agent. The package scripts can write `lib/**` or use formatter `--write`; this review stayed static except for read-only git/GitHub commands.

## Executive verdict

The package is already useful and mostly matches the spec: it is runner-agnostic at runtime, boots a real Seyfert client without gateway/token, supports the main dispatch verbs, records REST actions, seeds world state, mirrors a fair amount of cache, supports plugins/langs/events, and avoids forcing Vitest/Jest.

It is not publication-ready yet. The highest-value work is not adding more Discord surface. It is hardening the public contract and removing false-green paths:

1. Fix the published type surface: private `@slipher/types` leakage, unimportable `Dispatch` / `MockApiHandler`, peer range vs private Seyfert internals, and tests that bypass the package boundary.
2. Fix concurrency/modal attribution: bot-scoped dispatch ids, token attribution that confuses standalone webhooks with interaction webhooks, stale modal waiters, and scoped drains.
3. Make REST and world/cache fidelity fail loud: typed route params, better wait diagnostics, executable route coverage, role/permission gaps, cache mirroring, and settled `undefined` responses.
4. Improve the first-test author experience with additive agnostic helpers: `withMockBot`, guild fixtures, `requireAction`, `rest.call`, event builders, component naming, and class-first autocomplete.
5. Keep the package agnostic. Optional runner adapters or examples are fine; core should not import runner APIs or own assertions/spies/fake timers.

## Release blockers

These should be fixed before publishing `@slipher/testing@0.0.1`.

| ID | Item | Evidence | Why it matters |
| --- | --- | --- | --- |
| P0-01 | Remove private `@slipher/types` from public declarations | `packages/testing/src/index.ts:5` exports `./stubs`; `packages/testing/src/stubs.ts:2-10` imports `@slipher/types`; `packages/types/package.json:4` is private; `packages/testing/package.json:34-44` has it only as a devDependency. | External consumers can get unresolved `.d.ts` imports from a public package. |
| P0-02 | Export or hide public return/property types | `MockBot` public methods return `Dispatch` (`packages/testing/src/bot/bot.ts:434-460`), `MockBot.rest` is `MockApiHandler` (`bot.ts:732-735`), but the curated barrel omits both (`packages/testing/src/bot/index.ts:31-67`, `:195-211`). | Users cannot import the types that appear in public signatures without blocked deep imports. |
| P0-03 | Narrow the Seyfert compatibility promise or upstream test seams | Package advertises `seyfert >=5.0.0-0` (`packages/testing/package.json:43-44`), but implementation imports `seyfert/lib/...` (`packages/testing/src/bot/bot.ts:11-28`) and `seyfert-internals.ts` documents private internals (`:4-12`). Dev dep is a GitHub branch (`package.json:39`). | The peer range promises more compatibility than the package can actually support. |
| P0-04 | Add published-boundary tests | Tests mostly import `../../src/bot/...` directly; `packages/testing/test/testing.test.mts` only lightly covers `../src`. | Missing reexports, export-map issues, and declaration leaks can ship unnoticed. |
| P0-05 | Make `dispatchId` bot-scoped | `dispatch-context.ts:37-44` keeps a module-global counter; `createMockBot` resets it on every bot (`packages/testing/src/bot/bot.ts:2341-2344`). | Creating bot B while bot A is alive can cause dispatch id reuse and cross-bot action attribution. |
| P0-06 | Fix interaction-token attribution | `runInteraction` gathers actions by `action.dispatchId === dispatchId || action.route.split('/').includes(payload.token)` (`packages/testing/src/bot/bot.ts:1733-1739`); webhook and interaction routes share token-shaped segments (`packages/testing/src/bot/routes.ts:35-41`, `:219-220`). | Standalone webhook traffic with the same token segment can be reported as an interaction reply/followup. |
| P0-07 | Clean modal waiters when `untilModal()` loses | `onModalRegistered` stores waiters (`packages/testing/src/bot/bot.ts:1440-1455`); `Dispatch.untilModal` races registration vs completion but does not dispose the waiter on completion/error (`packages/testing/src/bot/dispatch.ts:96-111`). | A later dispatch for the same user can fail because a stale waiter still owns the modal slot. |
| P0-08 | Enforce missing role/ban permissions | `unban` lacks `BanMembers` (`packages/testing/src/bot/defaults.ts:982-989`); role edit/delete only require `ManageRoles`, not @everyone/hierarchy guards (`defaults.ts:700-716`). | Permission tests can pass while production Discord would reject the action. |

## Vetted candidates

Legend:

- `SI-P0`: fix before publish/merge.
- `SI-P1`: high-value work to schedule next.
- `SI-P2`: worthwhile polish after P0/P1.
- `TAL VEZ`: likely useful, but needs design or is not needed for first release.
- `NO`: reject, out of scope, already solved, or not worth it now.

### Public contract and release

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C01 | Inline or privatize `@slipher/types` use in `stubs.ts`. | SI-P0 | Repeated by release/spec/standards agents. Public declarations must not require a private workspace package. |
| C02 | Export `Dispatch` and `MockApiHandler`, or hide them behind public interfaces. | SI-P0 | They appear in public signatures/properties but are not importable from the only exported package root. |
| C03 | Narrow `peerDependencies.seyfert` to the exact supported range until public Seyfert test ports exist. | SI-P0 | Private `seyfert/lib/...` imports contradict the broad `>=5.0.0-0` promise. |
| C04 | Add package-boundary contract tests from the published entrypoint and built declarations. | SI-P0 | Current tests mostly use deep source imports, so the export map is under-tested. |
| C05 | Make `MockBot` non-constructible as public API, or export only an interface/factory return type. | SI-P1 | The constructor exposes `Client`, `MockApiHandler`, `MockGateway`, `MockWorld`, `WorldState` (`bot.ts:732-743`), which freezes implementation details. |
| C06 | Decide root barrel vs subpaths before publish. Keep root focused; move protocol/rest/state builders to explicit subpaths. | SI-P1 | `packages/testing/src/bot/index.ts:108-244` exports many low-level wire shapes and views from the root import. |
| C07 | Export `MockApiHandler` as a deliberate extension seam if `bot.rest` is public. | SI-P1 | Users can access `bot.rest` but cannot type/construct/share the REST seam cleanly. |
| C08 | Add `configureRest(rest)` or REST injection before startup. | SI-P1 | `createMockBot` creates REST at `bot.ts:2344`, runs startup at `:2456`, registers defaults at `:2460`, and only then returns `bot`. Startup/plugin REST cannot be stubbed beforehand. |
| C09 | Fix CRLF drift in changed root/config scripts. | SI-P2 | `biome.json:27` sets `lineEnding: "crlf"`; `scripts/vendor-internal.mjs` is LF-only and `turbo.json` is mixed by blob scan. |
| C10 | Inline the tiny `@slipher/internal` use instead of vendoring the whole internal package. | TAL VEZ | `stubs.ts` uses two helpers, but vendoring may be an accepted repo pattern. Do not block release on this if C01 is fixed. |
| C11 | Fix `@slipher/proxy` deep exports. | NO | Valid repo issue, but out of scope for this testing package review/PR. |

### Runner agnosticism and timers

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C12 | Remove Vitest-specific guidance from runtime error strings and public option comments. | SI-P1 | Timer docs/error copy mention `vi.useFakeTimers` directly (`bot.ts:629-635`, `:1491-1493`). Keep examples outside core or mention runners neutrally. |
| C13 | Formalize a minimal `ClockAdapter`; optional runner adapters can live in subpaths, not core. | SI-P1 | `timers.advance(ms)` exists (`bot.ts:637`), but users still need runner-specific caveat knowledge. |
| C14 | Avoid relying on import-time captured real timers only. | SI-P1 | REST captures `setTimeout` at module load (`rest.ts:7-11`), and bot captures `setImmediate` at module load (`bot.ts:643-650`). If fake timers are enabled before import, the "real" timer may already be fake. |
| C15 | Make drain iteration cap fail loud. | SI-P1 | `flushPending` and modal token drains return after the cap (`bot.ts:1478-1480`, `:1641-1646`) instead of reporting non-quiescence. |
| C16 | Add `withMockBot(options, fn)` for runner-agnostic cleanup. | SI-P2 | `close()` and async dispose exist (`bot.ts:2317-2337`), but tests repeat manual `await bot.close()` heavily. A `try/finally` helper improves DX without tying to a runner. |

### Dispatch, modal, and concurrency

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C17 | Make dispatch ids instance-scoped and never reset globally on another bot creation. | SI-P0 | See P0-05. |
| C18 | Restrict token attribution to interaction webhooks with known app/token ownership. | SI-P0 | See P0-06. |
| C19 | Dispose modal waiters when `untilModal()` completes through the failure/completion branch. | SI-P0 | See P0-07. |
| C20 | Scope modal token draining to matching token/in-flight work. | SI-P1 | `drainTokenUntilQuiescent` counts token actions but checks global `hasPendingRequests()` (`bot.ts:1641-1642`). Unrelated parked dispatches can delay modal submit results. |
| C21 | Fence `reset()` and `close()` against in-flight dispatches. | SI-P1 | `reset()` clears actions, waiters, registries, and interceptors (`bot.ts:2302-2315`) but does not epoch/cancel already-running dispatches. |
| C22 | Add dispatch-scoped action APIs. | SI-P1 | `bot.waitForAction/findAction` are global (`bot.ts:1302-1348`); concurrent tests must hand-roll `dispatchId` predicates. |
| C23 | Fail louder for created-but-never-awaited dispatches. | SI-P1 | `close()` only warns for unstarted dispatches (`bot.ts:2320-2323`). Silent lazy dispatches are a false-green risk. |
| C24 | Keep `Dispatch.untilModal()` internal or make it fully public. | SI-P2 | It is marked `@internal` (`dispatch.ts:83-89`) but lives on a public class if `Dispatch` is exported. Either document it or hide it. |

### REST and route model

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C25 | Type route params in `RouteMatcher`. | SI-P1 | `RouteMatcher` is only `{ method, route }` and `MatchedAction.params` is `Record<string,string>` (`rest.ts:161-167`). Public `Routes` could infer `{ guildId, channelId }`. |
| C26 | Add `rest.call(route, params, request)` and `routeUrl(route, params)`. | SI-P1 | `Routes` already knows method/path (`routes.ts:3-106`), while `rest.request` still requires raw method/url (`rest.ts:705-709`). |
| C27 | Make `ROUTE_COVERAGE` executable instead of another manual table. | SI-P1 | `ROUTE_COVERAGE` is a duplicated classification (`routes.ts:108-217`) and not wired to interceptor registration. |
| C28 | Replace parallel webhook/message regexes with the route matcher. | SI-P1 | Regex constants duplicate route knowledge (`routes.ts:219-222`) while `MockApiHandler.matches/matchParams` already exists (`rest.ts:444-465`). |
| C29 | Improve `waitForAction` diagnostics and add `requireAction` / `expectAction`. | SI-P1 | Filters can match body/query/response/error (`rest.ts:181-190`), but timeout only prints `METHOD route` (`rest.ts:594-600`). |
| C30 | Represent settled `undefined` responses without using `undefined` as the unsettled sentinel. | SI-P1 | Existing-action lookup waits for `response !== undefined || error !== undefined` (`rest.ts:588-591`), so an action whose legitimate response is `undefined` can be invisible later. |
| C31 | Tighten `registerGuildCrud` or split it into stricter helpers. | SI-P1 | It makes `idParam`, guards, and unknown behavior optional (`defaults.ts:86-104`); new entities can forget not-found/permission semantics without a type error. |
| C32 | Modularize `registerWorldDefaults` by domain. | TAL VEZ | The file is large and route registration is conflict-prone, but a full split is not required for first release if executable coverage lands. |
| C33 | Rename collection routes from inconsistent `fetch*` to canonical `list*` aliases. | SI-P2 | `Routes.fetchMessages/fetchRoles/fetchChannels/fetchBans/fetchPins` are list endpoints (`routes.ts:45-50`) while other list endpoints use `list*`. Add aliases; avoid churn-only breaking changes. |
| C34 | Make REST gate timeouts configurable. | TAL VEZ | Useful for slow CI, but not a blocker if scoped drains and diagnostics improve. |

### World, cache, permissions, and Discord fidelity

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C35 | Await cache mirror writes instead of `void` for stateful REST mutations. | SI-P1 | Emoji/sticker/ban/overwrite cache updates use `void hooks.cacheSet/cacheRemove` (`defaults.ts:727-739`, `:791`, `:971`, `:988`). Tests can observe world/cache divergence. |
| C36 | Mirror create/edit/delete channel and role mutations to cache. | SI-P1 | `createChannel/deleteChannel` mutate world only (`defaults.ts:514-538`); `createRole/editRole/deleteRole` mutate world only (`defaults.ts:695-716`). |
| C37 | Remove deleted roles from member role arrays. | SI-P1 | `WorldState.removeRole` removes the role entity only (`state.ts:1538-1541`), leaving stale role ids on members. |
| C38 | Enforce hierarchy/@everyone on role edit/delete. | SI-P0 | Role edit/delete lack `requireManageableRole` and @everyone checks (`defaults.ts:700-716`); member role add/remove has those checks (`defaults.ts:1115-1138`). |
| C39 | Require `BanMembers` on unban. | SI-P0 | `Routes.unban` checks guild and ban existence but not permissions (`defaults.ts:982-989`). |
| C40 | Apply parent overwrites/permissions to thread routes. | SI-P1 | Thread member/list/fetch routes mostly `requireChannel` only (`defaults.ts:816-837`); thread create delegates do not model Discord thread-specific permission gates. |
| C41 | Add missing snapshot/diff entities or document the deliberate boundary. | SI-P1 | Snapshot/diff includes many entities (`state.ts:789-806`, `:814-849`) but omits guild templates, soundboard sounds, stage instances, audit entries, and some richer message fields. |
| C42 | Fix stage cache keying and cache mirroring. | SI-P1 | Seed uses `stage.id` as cache id (`world.ts:367-369`), while REST fetch/delete operate by channel id (`defaults.ts:923-939`) and state indexes by `channel_id` (`state.ts:1855-1858`). |
| C43 | Make `MockWorld.data` genuinely passthrough or document it as structured-cloneable. | SI-P1 | `MockWorld.data` is documented as untouched (`world.ts:80-84`, `:305-311`), but `createMockBot` `structuredClone`s the built world (`bot.ts:2345-2347`). Function/class values fail or lose identity. |
| C44 | Allow `createMockBot({ world })` to accept a plain `MockWorld`, not only `WorldBuilder`. | SI-P2 | `MockBotOptions.world?: WorldBuilder` (`bot.ts:570-571`) makes generated/shared world objects harder to reuse. |
| C45 | Export missing world option types. | SI-P2 | `WorldEmojiOptions` and `WorldInviteOptions` exist (`world.ts:108-110`) but the public barrel exports only channel/guild/role/thread options (`bot/index.ts:245-254`). |
| C46 | Fix `apiPoll()` default to produce a valid poll or require answers. | SI-P2 | `apiPoll()` defaults to `answers: []` (`payloads.ts:837-856`), while message validation requires 1..10 answers (`message-validation.ts:352-370`). |
| C47 | Make `ApiGuild.roles` type realistic. | SI-P2 | `ApiGuild.roles` is `never[]` (`payloads.ts:45-53`), which is awkward for builders and consumers. |
| C48 | Validate poll routes against non-poll messages and invalid answer ids; add pagination if modeled. | SI-P1 | `endPoll` can return a non-poll message fallback (`defaults.ts:618-624`); `getPollAnswerVoters` does not reject unknown answer ids (`defaults.ts:626-632`). |
| C49 | Return seeded webhooks from `listChannelWebhooks` when present. | SI-P1 | Channel webhook list always returns `[]` (`defaults.ts:372-377`) even though state can query webhooks by channel (`state.ts:1730-1733`). |
| C50 | Add missing automod unknown-code behavior. | SI-P2 | Automod CRUD omits `unknownCode` (`defaults.ts:796-814`), so missing entities can synthesize instead of 404 in world mode. |

### Components, messages, assertions, and payload builders

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C51 | Rename canonical result fields from `button(s)` to `component(s)`. | SI-P1 | `collectButtons` collects component types 2..8 (`state.ts:590-604`); `panel.button('pick')` retrieves a select in tests (`components.test.mts:251-255`). Keep `button` aliases if needed. |
| C52 | Harvest section `accessory` interactive components. | SI-P1 | `walkComponents` visits `accessory` (`state.ts:612-618`), but `collectButtons` recurses only through `components` (`state.ts:590-605`), so accessory buttons/selects are not in `buttons`. |
| C53 | Keep Components v2 edit semantics strict. | SI-P1 | `assertSendableMessage` only treats a body as v2 when the edited body carries the v2 flag (`message-validation.ts:312-347`). Edits to an existing v2 message can slip through unless all flags are repeated. |
| C54 | Include `accessory` in attachment-reference walking. | SI-P1 | Component attachment refs recurse through `components`, `items`, `media`, and `file` (`message-validation.ts:418-429`), not `accessory`. |
| C55 | Validate `message_reference` existence/shape more explicitly. | SI-P1 | `addMessage` copies references and snapshots opportunistically (`state.ts:1210-1234`); `assertSendableMessage` does not validate reference targets (`message-validation.ts:382-390`). |
| C56 | Expand result views/assertions for attachments, references, polls, and files. | SI-P2 | `MessageView` exposes more (`state.ts:2028-2055`), but `MessageResultBase` mostly normalizes messages/embeds/files/buttons/text (`bot.ts:385-419`). |
| C57 | Improve outcome semantics for defer/modal/non-visible replies. | SI-P2 | Response checks should distinguish dispatch acknowledgement from rendered visible messages; a defer/modal callback can be counted even when no user-visible message was sent. |
| C58 | Add builders for every world-bridged event. | SI-P1 | `WorldEmitEvent` covers 14 events (`world-events.ts:10-24`), while payload builders cover only member add/update/remove and reaction add (`payloads.ts:670-720`). |
| C59 | Add class-first autocomplete and better grouped subcommand typing. | SI-P1 | `slash(Class, options)` exists (`bot.ts:1874-1894`), but `autocomplete` is raw-name only (`bot.ts:1905-1929`). |
| C60 | Make required slash options required at the type level. | TAL VEZ | Helpful DX, but TypeScript inference may become brittle. Do after public API stabilization. |
| C61 | Add integer/number helpers or clearer raw option escape hatches. | SI-P2 | `rawOption(type, value)` exists (`interactions.ts:66-68`), but direct numbers rely on inference (`interactions.ts:163-174`). This is polish. |
| C62 | Add a standalone component happy-path helper. | SI-P1 | `clickButton` without source throws unless `allowSyntheticSource` is set (`bot.ts:1986-2001`); tests show the first handler-only path needs that flag (`components.test.mts:91-100`). |

### Actors, plugins, gateway, i18n, and hackability

| ID | Candidate | Verdict | Reason |
| --- | --- | --- | --- |
| C63 | Preserve actor member info and expose actor identity/options. | SI-P1 | `actor(options)` computes `user/guildId/channel` but drops `options.member` from the base (`bot.ts:2100-2138`). |
| C64 | Resolve actor members by guild + user, not user alone. | SI-P1 | Actor member lookup uses only `candidate.member.user.id` (`bot.ts:2101-2103`), which is ambiguous for multi-guild worlds. |
| C65 | Add a public `mockGuildFixture` or similar happy-path fixture. | SI-P1 | Tests already have a private `seedGuildFixture` (`test/bot/_setup.ts:27-33`), and repeat world/guild/member/channel boilerplate. |
| C66 | Fail loudly when `client` causes other options to be ignored. | SI-P1 | `MockBotOptions.client` says `clientOptions`/prefixes are ignored (`bot.ts:591-594`), but only `client + plugins` warns (`bot.ts:2353-2358`). |
| C67 | Compose, do not replace, event failure reporting. | SI-P1 | `reportEventFailure` is replaced in `createMockBot` (`bot.ts:2405-2411`) rather than delegating to an existing handler. |
| C68 | Give plugin diagnostics index/name mapping and context `extra` injection. | SI-P2 | Valuable for plugin authors, but less urgent than public contract and concurrency. |
| C69 | Productize plugin conformance helpers. | SI-P2 | Existing tests form a useful plugin compatibility suite; expose helpers only after core public surface settles. |
| C70 | Implement or remove `MockGatewayOptions.handlePayload`; add inbound gateway dispatch if intended. | SI-P1 | `MockGatewayOptions.handlePayload` exists (`gateway.ts:9-18`) but `MockGateway` only records outbound `send` and simulate disconnect/reconnect (`gateway.ts:43-64`). |
| C71 | Validate shard ids in mock gateway operations. | SI-P2 | `send`, `simulateDisconnect`, and `simulateReconnect` accept any shard id (`gateway.ts:49-64`). Small correctness gap. |
| C72 | Improve unknown gateway event typo diagnostics. | SI-P2 | Unknown uppercase event names fall through to custom events (`bot.ts:2147-2159`) and tests expect `no custom handler ran` for `GUILD_MEMBER_ADDD` (`events.test.mts:186-189`). |
| C73 | Avoid `structuredClone` on i18n values if functional translations are supported. | SI-P1 | `clientLifecycle(client).langBaseValues = structuredClone(client.langs.values)` (`bot.ts:2425-2438`). If lang entries contain functions, this breaks. |
| C74 | Add custom simulation plugins for routes/events/snapshot serializers. | TAL VEZ | This is the right long-term hackability story, but design it after public contract hardening. |
| C75 | Ask Seyfert for a public `ClientTestHarness` / instrumentation port. | TAL VEZ | It is the strategic fix for private internals, but it crosses package boundaries and should not block a minimal first release if C03 is honest. |
| C76 | Expose full internal mutator surfaces directly. | NO | That would make `WorldState`/REST internals semver API. Prefer narrow ports and helpers. |

## Things explicitly not worth doing now

| Item | Verdict |
| --- | --- |
| Force built-in assertions, spies, or fake timers. | NO. It violates the agnostic goal. Keep helper errors runner-neutral and optional. |
| Move everything into separate packages immediately. | NO. Subpaths are enough until the API shape proves stable. |
| Treat local README/markdown drift as review source. | NO. User explicitly said local markdown is outdated. |
| Deep support for every possible Seyfert client class before first release. | NO for now. Narrow the peer range and test the supported client path first. |
| Large register-world refactor before fixing contract/concurrency bugs. | NO. It is useful, but P0 issues matter more. |
| Keep `button()` as the canonical selector for selects. | NO. It should become `component()` or similar; `button()` can stay as alias. |

## Recommended implementation order

1. Public contract hardening: C01-C04, C17-C19, C38-C39.
2. Runner/REST/concurrency correctness: C12-C15, C20-C31.
3. World/cache/message fidelity: C35-C37, C40-C55, C58.
4. Authoring DX: C16, C33, C56-C65, C70-C73.
5. Hackability roadmap: C74-C75 after the package API is stable.

## Agent ledger

Exactly 50 successful agents were used. Each row is the primary focus and the strongest surviving signal from that agent.

| # | Focus | Strongest signal |
| --- | --- | --- |
| 1 | Public API barrel | Missing public exports and over/under-curated root surface. |
| 2 | `createMockBot` lifecycle/options | Ignored options with injected clients should fail/warn loudly. |
| 3 | Actor API | Actor drops member info and resolves members too broadly. |
| 4 | Dispatch API | Lazy dispatch and `until` semantics can create false greens. |
| 5 | Slash/type DX | More class-first and typed option/subcommand affordances. |
| 6 | Components | `button(s)` naming is wrong for selects/components. |
| 7 | Modal flows | Stale modal waiters after failed/no-modal dispatch. |
| 8 | Autocomplete/context/prefix | `say`/entry/autocomplete flows need clearer result/error shape. |
| 9 | Events/gateway | Event bridge is partial; custom/gateway typing can improve. |
| 10 | Routes | Route naming and regex duplication cause drift. |
| 11 | `MockApiHandler` | Wait/gate/reset edge cases and fixed timeouts. |
| 12 | `WorldBuilder` | Accept plain worlds and seed more non-entity side state. |
| 13 | World readers | Snapshot/diff omit lower-frequency entities. |
| 14 | Message views | Add richer message assertion/result views. |
| 15 | Outcome readers | Response and denial readers need sharper semantics. |
| 16 | Payload factories | `apiPoll` default and payload type gaps. |
| 17 | Permissions | Ban/role/thread permission fidelity gaps. |
| 18 | Error/denial capture | Preserve user error handlers and compose failure capture. |
| 19 | Fake timers | Captured timers and runner-specific guidance need cleanup. |
| 20 | Plugins | Plugin diagnostics and context extension seams. |
| 21 | Client injection | Injected clients need clearer option policy. |
| 22 | Cache mirroring | REST world mutations can diverge from Seyfert cache. |
| 23 | Mock gateway | Inbound gateway hooks/options are incomplete. |
| 24 | i18n/langs | `structuredClone` and default locale handling need scrutiny. |
| 25 | Core REST/world | Role delete/member tombstones/reaction guards; some were already fixed, others remain. |
| 26 | Components v2 | V2 validation/edit/harvest gaps. |
| 27 | Attachments/references | Reference and attachment assertion gaps. |
| 28 | Webhooks | Some webhook gaps are now fixed; channel list and attribution remain. |
| 29 | Polls | Non-poll/answer/pagination validation gaps. |
| 30 | Automod/threads | Automod missing unknown behavior; thread member/permission gaps. |
| 31 | Low entities | Stage/templates/soundboard/audit snapshot/cache gaps. |
| 32 | Custom world data | `data` is not truly verbatim through `structuredClone`. |
| 33 | Deep import isolation | Seyfert internals and package-boundary tests. |
| 34 | Runner agnosticism | No runner imports found; copy/adapters need neutralization. |
| 35 | Package build/exports | Private type and peer dependency risks. |
| 36 | Tests as spec | Tests import source internals too much. |
| 37 | Type safety | Public type tests and route generics need hardening. |
| 38 | Discoverability | Diagnostics/introspection can expose better registered surfaces. |
| 39 | Concurrency | Bot-scoped dispatch ids and webhook token attribution are real bugs. |
| 40 | Reset/isolation | Reset/close should fence in-flight dispatches. |
| 41 | Naming consistency | `components`, `bot.world`, `list*`, `updateWorld` naming. |
| 42 | Bloat/scope | Private type leak, constructible `MockBot`, root barrel bloat. |
| 43 | Maintainability/defaults | Route coverage should be executable; defaults should be modular eventually. |
| 44 | Missing APIs | Guild fixture, `withMockBot`, `rest.call`, event builders. |
| 45 | Roadmap/product | Public Seyfert test seams, clock adapter, simulation plugins. |
| 46 | Hackability/extension | Public REST seam and pre-start REST configuration. |
| 47 | Learning curve | Synthetic component happy path and REST diagnostics. |
| 48 | Release readiness | Private type leak, unimportable public types, peer range, package-boundary tests. |
| 49 | Review - standards | Private type leak and CRLF formatting drift. |
| 50 | Review - spec | Spec mostly matches; remaining gaps are packaging/public API and Seyfert compatibility contract. |

## Bottom line

Do not spend the next iteration adding every missing Discord endpoint. The package is more likely to hurt users through public-contract leaks, false-green concurrency, and unclear ergonomics than through missing niche surfaces. Fix the P0 set, add the P1 DX helpers that reduce ceremony without coupling to a runner, and keep the deeper hackability work as explicit follow-up design.
