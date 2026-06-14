# Discord bot testing guide triage

This documents what was intentionally left out of the `@slipher/testing` fix pass from `discord-bot-testing-guide.md`.

The pass did not treat the guide as a spec to implement in full. I applied the small, contract-backed fidelity bugs that could be proven with focused tests and left out changes that would create new public API, change broad harness semantics, or require a separate design pass.

## Applied or partially applied

| Guide item | Status | Notes |
| --- | --- | --- |
| Fix modal submit/open component shape | Applied | `modalSubmitInteraction()` now emits `ComponentType.Label` with a nested text input so `ModalContext#getInputValue()` works. |
| Resolve world members/roles in selects, options & context-menu targets | Partially applied | I fixed world-backed user/mentionable selects that crashed when resolved members lacked `permissions`. I did not add broader option/context-menu target resolution changes. |
| Route plugin-contributed commands/components/modals/langs through dispatch + lifecycle hooks + typed accessor | Partially applied | `createMockBot()` now runs plugin setup plus contribution refresh, and a regression test covers plugin-contributed commands. I did not add a public typed contribution accessor or exhaustive lifecycle coverage. |
| Forward guildId/channelId to dispatch | Applied | Omitted guild/channel IDs now use stable test defaults instead of fresh IDs per dispatch. |
| Honor componentType / dispatcher kind | Applied | `userMenu()` and `messageMenu()` now require a registered command of the matching Discord application-command type. |
| Accept dispatch locale/guildLocale; avoid empty-result crash on unknown locale | Partially applied | `createMockBot({ langs })` now auto-selects a default locale. I did not add `guildLocale` options or resolved-locale accessors. |
| Stop dropping files on edits/followups | Partially applied | Deferred edits and followups now preserve `files` in semantic results. I did not add a unified files accessor, timeline, followup edits, deletes, or attachment metadata normalization. |

## Not added and why

| Guide item | Why it was not added in this pass |
| --- | --- |
| Make deferred/fetchReply responses return a real message | This changes response materialization, collector keys, REST fallback behavior, and message state. It needs a dedicated design/test pass because returning a synthetic message in the wrong shape can make collector tests pass while drifting from Discord/Seyfert behavior. |
| Drive REST/cache through the started client | This is an architectural fix for singleton divergence. It touches how production modules import clients and how the harness installs services. I left it out because it can change every command that uses global client state. |
| Fix queues teardown crash + memory/persistent driver divergence | This crosses `@slipher/testing`, queues, persistent drivers, lifecycle disposal, retry timing, and close semantics. It is a separate package-level fix, not a small mock-bot dispatch patch. |
| Key options by name, fix NUMBER/Integer encoding, typed-payload crashes | This requires a public input-shape decision for slash options. Changing accepted option input can break existing tests, especially where plain arrays or integers currently map implicitly. |
| Make WorldState reflect live cache mutations | This changes the model from a seed snapshot to a live view. That is broad state semantics and needs full cache-resource coverage so the view does not become partially live and misleading. |
| Seed parent channel and expand thread/mod-bot REST routes | This adds more REST defaults and cache assumptions. I left it out because route expansion should be done with a route inventory and tests for parent-channel, thread, and mod-bot edge cases together. |
| Fix MockScheduler/MockLogger/MockQueue fidelity + stubs.d.ts dependency resolution | These are stub-contract changes outside the interaction dispatch path. They need comparison against the real plugin APIs and could affect unrelated package tests. |
| Make ephemeral/content reflect the delivered message | This changes `DispatchResult` semantics. Today `ephemeral` reflects the first interaction callback, and `content` prefers edits over replies. Expanding it to delivered-message semantics needs a compatibility decision. |
| Seed permission_overwrites + all cache resources | This is a large cache fidelity task: overwrites, messages, voice states, presence, emoji, bans, stickers, threads. I did not mix it into a targeted interaction-fidelity commit. |
| Gate context-menu and subcommand perms; register bot member for botPermissions | This would make the harness enforce permission rules that many existing tests may not seed correctly. It needs an opt-in or migration plan rather than a quiet behavior change. |
| Boot loadFromConfig with plugins+middlewares, cwd override, explicit-commands merge, guided build error | This changes loader behavior and config resolution. It should be handled as a loader-contract pass with config fixtures, not as a dispatch fix. |
| Lenient/guarded close() + reset() + closed-guard for shared-bot isolation | This introduces lifecycle API and post-close behavior. It is useful, but it needs API design for whether dispatch after close throws, warns, or no-ops. |
| Let bot.calls()/matcher filter by method & body; record responder errors | `bot.calls()` already has a predicate escape hatch. Adding richer matcher semantics is public assertion API design and should be specified before implementation. |
| Fix registration traps, update-payload crashes, onInternalError reply path | This combines unrelated failure modes: decorator misuse, gateway update payload shape, and internal-error response behavior. Each needs separate repros and expected outcomes. |
| Capture thrown/denied outcomes into error+denial channels | This would alter the core promise/result contract. It is high-value, but needs a clear model for command throws, middleware stops, internal errors, denials, and hangs so tests do not silently change meaning. |
| Unresolvable dispatch throws for typo'd customId/subcommand/event/dead collector | This is a broad behavior change from permissive/no-op to strict. It likely needs an opt-in strict mode or migration note because existing tests may rely on no-op dispatches. |
| Normalize all responses into one `res.messages` view | This is a new semantic response layer covering embeds, files, content, timeline, updates, locale, subcommands, and autocomplete. I left it out because it is additive API design, not a root bug fix. |
| Add service/client injection seam for module-level imports | Mocking module-level imports requires loader hooks or require-cache shims and ordering rules. That is brittle unless designed explicitly around ESM/CJS and command loading. |
| Add harness clock and make timers/jobs fire | A virtual clock must integrate queues, scheduler, cooldown, waiters, collectors, and retry/backoff. Partial clock support would be worse than none because tests would look deterministic while real timers still run. |
| Add log-capture/silencing seam | Useful, but it introduces logger plugin coupling and a new `bot.logs` API. It belongs in a logging-specific harness pass. |
| Provide `mockComponentContext` / `mockModalContext` | These are new unit-test fixtures. They should mirror real `ComponentContext` and `ModalContext` enough to be trusted, which is a separate API surface. |
| Option-constraint validation stays userland | The guide itself classifies this as userland. Enforcing choices, min/max, required, and channel types would make the harness stricter than current behavior and needs an opt-in strict mode. |
| `mock*`/`api*` factory naming and shape unification | This is a type/API ergonomics change. It should be done as a documented adapter or overload pass so existing camelCase and snake_case fixture families remain predictable. |
| Embed/color/choice-count matchers stay userland recipes | The guide classifies this as userland. Matchers are useful, but they are test ergonomics, not dispatch fidelity. They also pair better with a future `res.embed`/`res.embeds` API. |
| Positive confirmations | No change was needed. These were confirmations that current behavior already works or that the issue is documentation/ergonomics rather than a broken path. |

## Criteria used

I added items when all of these were true:

- The current code had a concrete mismatch with installed Seyfert/Discord payload shape.
- The fix was small and local to `@slipher/testing` mock bot behavior.
- A focused regression test could fail before the fix and pass after it.
- The change did not require a new public API contract or a migration story.

I left items out when any of these were true:

- The change introduced new public API.
- The change spanned multiple packages or broad cache/lifecycle semantics.
- The report itself classified it as userland or positive confirmation.
- A partial implementation would make tests look more faithful without actually matching production behavior.
