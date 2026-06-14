# Discord bot testing guide triage

This documents what was intentionally left out of the `@slipher/testing` fix passes from `discord-bot-testing-guide.md`.

The first pass avoided new public API. The follow-up pass applied local `@slipher/testing` contract changes that did not require changing upstream Seyfert. The remaining items either require upstream behavior, cross-package architecture, or a larger design pass.

## Applied or partially applied

| Guide item | Status | Notes |
| --- | --- | --- |
| Fix modal submit/open component shape | Applied | `modalSubmitInteraction()` now emits `ComponentType.Label` with a nested text input so `ModalContext#getInputValue()` works. |
| Resolve world members/roles in selects, options & context-menu targets | Partially applied | World-backed user/mentionable selects now default member permissions; minimal role options are normalized; user context menus include world-backed `resolved.members`. I did not add every modal select/file component reader. |
| Route plugin-contributed commands/components/modals/langs through dispatch + lifecycle hooks + typed accessor | Partially applied | `createMockBot()` now runs plugin setup plus contribution refresh, and a regression test covers plugin-contributed commands. I did not add a public typed contribution accessor or exhaustive lifecycle coverage. |
| Forward guildId/channelId to dispatch | Applied | Omitted guild/channel IDs now use stable test defaults instead of fresh IDs per dispatch. |
| Honor componentType / dispatcher kind | Applied | `userMenu()` and `messageMenu()` now require a registered command of the matching Discord application-command type. |
| Accept dispatch locale/guildLocale; avoid empty-result crash on unknown locale | Partially applied | `createMockBot({ langs })` now auto-selects a default locale, and interaction payload builders accept `guildLocale`. I did not add new resolved-locale accessors because Seyfert does not expose one here. |
| Stop dropping files on edits/followups | Partially applied | Deferred edits/followups preserve `files`; `DispatchResult.files` and `messages` expose them; webhook followup edit/delete routes now mutate `WorldState`, and followup edits are included in semantic results. I did not add attachment metadata normalization. |
| Key options by name, fix NUMBER/Integer encoding, typed-payload crashes | Applied | Slash/autocomplete options accept `{ name, value }[]`; registered command metadata preserves declared `Number` vs `Integer` for whole numbers. |
| Make ephemeral/content reflect the delivered message | Applied | `DispatchResult.content` now reflects the latest delivered message and `ephemeral` reflects delivered message flags, including followups. |
| Normalize all responses into one `res.messages` view | Applied | `DispatchResult.messages`, `embeds`, `embed`, and `files` now provide one normalized read layer across replies, updates, edits, and followups. |
| Lenient/guarded close() + reset() + closed-guard for shared-bot isolation | Applied | `close()` is idempotent, `reset()` clears recorded REST state/dispatch handles, and dispatch after close throws synchronously. |
| Let bot.calls()/matcher filter by method & body; record responder errors | Applied | `calls()`, `call()`, `waitForAction()`, and gates accept richer action filters; route-template filters expose params; response/error waits settle after the responder; responders that throw are recorded on `RecordedAction.error` before rethrow. |
| Provide `mockComponentContext` / `mockModalContext` | Partially applied | Added standalone component and modal context helpers with shared stubs and response capture. They cover common button/select values and text-input modal fields, not every Discord modal component reader. |
| Unresolvable dispatch throws for typo'd customId/subcommand/event/dead collector | Partially applied | Slash subcommand typos, component custom IDs with no collector/ComponentCommand, and modal custom IDs with no waiting modal/ModalCommand now throw. I did not make unregistered events throw because event emission can be used for cache-only flows. |
| Option-constraint validation stays userland | Partially applied | Default behavior remains permissive, but `createMockBot({ validateOptions: true })` can opt into required/min/max/choice/channel-type validation for command metadata. |
| `mock*`/`api*` factory naming and shape unification | Partially applied | Existing camelCase factory fields remain, with snake_case/API-compatible aliases and enough payload fields for option helpers. This is not a full factory-family rename. |

## Not added and why

| Guide item | Why it was not added in this pass |
| --- | --- |
| Make deferred/fetchReply responses return a real message | This changes response materialization, collector keys, REST fallback behavior, and message state. It needs a dedicated design/test pass because returning a synthetic message in the wrong shape can make collector tests pass while drifting from Discord/Seyfert behavior. |
| Drive REST/cache through the started client | This is an architectural fix for singleton divergence. It touches how production modules import clients and how the harness installs services. I left it out because it can change every command that uses global client state. |
| Fix queues teardown crash + memory/persistent driver divergence | This crosses `@slipher/testing`, queues, persistent drivers, lifecycle disposal, retry timing, and close semantics. It is a separate package-level fix, not a small mock-bot dispatch patch. |
| Make WorldState reflect live cache mutations | This changes the model from a seed snapshot to a live view. That is broad state semantics and needs full cache-resource coverage so the view does not become partially live and misleading. |
| Seed parent channel and expand thread/mod-bot REST routes | Followup webhook message edit/delete is now covered. Broader route expansion remains out because thread, parent-channel, and mod-bot routes need an inventory pass together. |
| Fix MockScheduler/MockLogger/MockQueue fidelity + stubs.d.ts dependency resolution | These are stub-contract changes outside the interaction dispatch path. They need comparison against the real plugin APIs and could affect unrelated package tests. |
| Seed permission_overwrites + all cache resources | This is a large cache fidelity task: overwrites, messages, voice states, presence, emoji, bans, stickers, threads. I did not mix it into a targeted interaction-fidelity commit. |
| Gate context-menu and subcommand perms; register bot member for botPermissions | This would make the harness enforce permission rules that many existing tests may not seed correctly. It needs an opt-in or migration plan rather than a quiet behavior change. |
| Boot loadFromConfig with plugins+middlewares, cwd override, explicit-commands merge, guided build error | This changes loader behavior and config resolution. It should be handled as a loader-contract pass with config fixtures, not as a dispatch fix. |
| Fix registration traps, update-payload crashes, onInternalError reply path | This combines unrelated failure modes: decorator misuse, gateway update payload shape, and internal-error response behavior. Each needs separate repros and expected outcomes. |
| Capture thrown/denied outcomes into error+denial channels | This would alter the core promise/result contract. It is high-value, but needs a clear model for command throws, middleware stops, internal errors, denials, and hangs so tests do not silently change meaning. |
| Add service/client injection seam for module-level imports | Mocking module-level imports requires loader hooks or require-cache shims and ordering rules. That is brittle unless designed explicitly around ESM/CJS and command loading. |
| Add harness clock and make timers/jobs fire | A virtual clock must integrate queues, scheduler, cooldown, waiters, collectors, and retry/backoff. Partial clock support would be worse than none because tests would look deterministic while real timers still run. |
| Add log-capture/silencing seam | Useful, but it introduces logger plugin coupling and a new `bot.logs` API. It belongs in a logging-specific harness pass. |
| Embed/color/choice-count matchers stay userland recipes | The guide classifies this as userland. Matchers are useful, but they are test ergonomics, not dispatch fidelity. They also pair better with a future `res.embed`/`res.embeds` API. |
| Positive confirmations | No change was needed. These were confirmations that current behavior already works or that the issue is documentation/ergonomics rather than a broken path. |

## Criteria used

I added items in the follow-up pass when all of these were true:

- The current code had a concrete mismatch with installed Seyfert/Discord payload shape.
- The fix was local to this worktree and did not require changing upstream Seyfert.
- A focused regression test could fail before the fix and pass after it.
- Any new public API was additive or opt-in.

I left items out when any of these were true:

- The change introduced new public API.
- The change spanned multiple packages or broad cache/lifecycle semantics.
- The report itself classified it as userland or positive confirmation.
- A partial implementation would make tests look more faithful without actually matching production behavior.
