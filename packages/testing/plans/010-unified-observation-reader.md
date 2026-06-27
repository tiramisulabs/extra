# 010 - Result Checks + Screen Reader

Status: Superseded by 011 - Outcome Reader
Date: 2026-06-27
Scope: `packages/testing`

## Decision

Do not unify dispatch facts and rendered Discord output into one `get/query/all` surface.

This looked attractive because it removed helpers, but it made the public interface confusing: `response`,
`denial`, and `error` are facts about how the dispatch completed; `message`, `embed`, `button`, and `container`
are things Discord rendered. When those names become siblings, the caller has to understand the package internals.

Keep two user-facing ideas:

1. **Result checks**: did this dispatch respond, get denied, or capture an error?
2. **Screen reader**: what did the bot put on the Discord screen?

The rendered reader still replaces future `expectEmbed` / `expectComponent` style helpers. The lifecycle helpers
stay separate because they do not inspect rendered UI.

## Final Shape

Common command test:

```ts
const result = await bot.slash({ name: "settings" });

outcome(result).get.response();

const panel = result.screen.get.container({ content: /Settings/i });
panel.get.select("reason");
panel.get.content({ text: /Client POV/i });
```

Denied dispatch:

```ts
const result = await bot.slash({ name: "admin" });

outcome(result).get.denial({ kind: "permissions", missing: "ManageGuild" });
expect(result.screen.query.button("admin:save")).toBeUndefined();
```

Captured error after partial output:

```ts
const result = await bot.slash({ name: "sync" });

outcome(result).get.error(/post-send failure/i);
result.screen.get.message({ content: /Working/i });
```

Counts and absence stay in the user's test runner:

```ts
expect(result.screen.all.button({ label: "Edit" })).toHaveLength(2);
expect(result.screen.all.button({ label: "Edit" }).length).toBeGreaterThan(0);
expect(result.screen.query.button("danger:delete")).toBeUndefined();
expect(result.screen.all.embed({ contains: /internal error/i })).toHaveLength(0);
```

In-flight flow:

```ts
const flow = bot.slash({ name: "setup" });
await flow.untilComponent("continue");

flow.screen.get.button("continue");
flow.screen.get.container({ content: /Setup/i });

const result = await flow;
outcome(result).get.response();
```

Raw/builder escape hatch:

```ts
rendered(builder).get.button("retry");
rendered(rawMessage).get.container({ content: /Settings/i });
rendered(rawModal).get.modal("reject-request");
```

## Naming

Use `screen` for bot-produced rendered output:

```ts
result.screen.get.message({ content: /Saved/i });
result.screen.get.button("retry");
```

Reasons:

- It describes the user's mental model: "what did the bot put in front of the Discord user?"
- It avoids `ui`, which sounds like a generic web surface.
- It avoids `output`, which is too vague.
- It avoids `rendered` as a common-case property, which is technically correct but not user-friendly.

Use `rendered(subject)` only for standalone raw values/builders because they are not dispatch results and cannot
own a `.screen` property.

## Result Checks

Keep lifecycle/result checks separate from the screen reader through `outcome(result)`:

```ts
outcome(result).get.response(query);
outcome(result).get.denial(query);
outcome(result).get.error(matcher);
```

`response` is intentionally broader than a visible message. It passes for acknowledged responses such as defer,
modal response, message update, edit, or followup. If the test needs a visible message, the test should use
`result.screen.get.message(...)`.

Suggested response query:

```ts
export interface ResponseQuery {
  ephemeral?: boolean;
  deferred?: boolean;
  deferredReply?: boolean;
  deferredUpdate?: boolean;
  command?: string | { name?: TextMatcher; group?: TextMatcher; subcommand?: TextMatcher };
}
```

Do not add `screen.get.response`, `screen.get.denial`, or `screen.get.error`.

## Screen Reader

The screen reader is the current rendered-output reader, attached to bot-produced results:

```ts
export interface ScreenReader extends RenderedScope {
  readonly raw: RawOutput;
  debug(): string;
}

export interface RenderedScope {
  readonly get: Finder<"get">;
  readonly query: Finder<"query">;
  readonly all: Finder<"all">;
}
```

Reader modes:

```ts
result.screen.get.button("retry");   // exactly one -> ButtonView
result.screen.query.button("retry"); // first match or undefined
result.screen.all.button(query);     // all matches, possibly []
```

Semantics:

- `get`: returns exactly one item. Throws a screen diagnostic error when there are zero matches or multiple matches.
- `query`: returns the first match in normalized render order, or `undefined`. It does not throw on multiple
  matches.
- `all`: returns all matches in normalized render order. It returns `[]` when there are no matches.

No `single`, `maybe`, `has`, or `none`.

## Components V2

Components V2 stays container-first:

```ts
const panel = result.screen.get.container({ content: /Settings/i });

panel.get.button("save");
panel.get.select("reason");
panel.get.input("notes");
panel.get.content({ text: /Client POV/i });
panel.get.media({ url: /preview\.png$/ });
panel.get.section({ content: /Danger zone/i });
panel.all.component("separator");
```

Do not inflate the root reader with one method per Discord subcomponent. Root methods should stay focused:

```ts
result.screen.get.message({ content: /Settings/i });
result.screen.get.modal("reject-request");
result.screen.get.embed({ title: /Campaign/i });
result.screen.get.button("retry");
result.screen.get.select("reason");
result.screen.get.input("notes");
result.screen.get.container({ content: /Settings/i });
result.screen.get.component("separator", { divider: true });
```

Section/accessory scope remains explicit:

```ts
const section = result.screen
  .get.container({ content: /Settings/i })
  .get.section({ content: /Client POV/i });

section.accessory().get.button("client:edit");
```

## Explicit Query Rules

String shorthand is allowed only when the identity is technical and unambiguous:

```ts
result.screen.get.button("custom_id");
result.screen.get.select("custom_id");
result.screen.get.input("custom_id");
result.screen.get.modal("custom_id");
```

No magic visible-text shorthand:

```ts
result.screen.get.message({ content: /Settings/i });
result.screen.get.container({ content: /Settings/i });
result.screen.get.container({ content: /Settings/i }).get.content({ text: /Settings/i });
```

Do not support:

```ts
result.screen.get.message(/Settings/i);
result.screen.get.container(/Settings/i);
result.screen.get.button("Save"); // ambiguous label/custom_id
```

## Public Interface Sketch

```ts
export interface MessageResultBase {
  readonly screen: ScreenReader;
}

export interface DispatchResult extends MessageResultBase {
  // existing fields...
}

export interface SayResult extends MessageResultBase {}
export interface EventDispatchResult extends MessageResultBase {}

export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
  get screen(): ScreenReader;
}

export function rendered(subject: RenderedSubject, options?: RenderedOptions): ScreenReader;
```

If `screen` as an eager property creates snapshot noise or unnecessary work, make it a lazy getter. If possible,
define it as non-enumerable on result objects so existing object snapshots do not suddenly include a large reader
surface.

`rendered(subject)` should be the standalone entry point for the current rendered-output implementation.

## Raw Escape Hatch

Raw rendered data remains available from the screen reader:

```ts
const message = result.screen.get.message({ content: /Settings/i });
expect(message.raw.body.flags).toBe(MessageFlags.IsComponentsV2);

expect(result.screen.raw.actions()).toHaveLength(1);
```

Use raw for wire-shape assertions only. Normal rendered-output assertions should use typed readers.

## Edge Cases To Preserve

Denied but rendered a message:

```ts
outcome(result).get.denial({ kind: "permissions" });
result.screen.get.message({ content: /missing permission/i });
```

Error after partial output:

```ts
outcome(result).get.error(/post-send failure/i);
result.screen.get.message({ content: /Working/i });
```

Modal-only response:

```ts
outcome(result).get.response();
result.screen.get.modal("reject-request");
```

Defer-only response:

```ts
outcome(result).get.response({ kind: "defer" });
expect(result.screen.all.message()).toHaveLength(0);
```

Parked dispatch:

```ts
const flow = bot.slash({ name: "setup" });
await flow.untilComponent("continue");

flow.screen.get.button("continue");
```

`flow.screen` must read what has already rendered. It must not start, await, or unblock the dispatch.

## Diagnostics

Rendered diagnostics should mention `screen`, not `output`:

```txt
result.screen.get.button("edit") found 2 buttons; get.button requires exactly one.

Use a scope:
  result.screen.get.message({ content: /Profile/ }).get.button("edit")
  result.screen.get.container({ content: /Settings/ }).get.button("edit")

Or use:
  result.screen.all.button({ customId: "edit" })
```

Result-check diagnostics should stay result-oriented:

```txt
outcome(result).get.response() found 0 responses - dispatch was denied (permissions).
```

```txt
outcome(result).get.error() found 0 errors - dispatch produced no user-visible output.
(Did you set onCommandError: "capture"?)
```

## Implementation Plan

### Step 1: Rename the standalone rendered reader

- Keep the current rendered-output normalization implementation.
- Export it as `rendered(subject, options?)`.
- Do not keep an `output(subject, options?)` alias unless the API has already shipped and compatibility is required.
- Update docs/examples to prefer `result.screen` for bot results and `rendered(raw)` for raw/builders.

### Step 2: Attach `screen` to result objects

- Add `screen: ScreenReader` to `MessageResultBase`.
- Ensure `DispatchResult`, `SayResult`, and `EventDispatchResult` expose it.
- Build the screen from the same result/actions/messages that `rendered(result)` already accepts.
- Prefer a lazy getter to avoid doing normalization unless the test uses it.
- Prefer non-enumerable if practical to avoid noisy snapshots.

### Step 3: Attach `screen` to in-flight `Dispatch`

- Add `get screen(): ScreenReader` to `Dispatch`.
- It should use the dispatch's recorded actions scoped by `dispatchId`.
- It must not call `then`, await the dispatch, release checkpoints, or change execution state.

### Step 4: Add the outcome reader

- Implement `outcome(result).get.response(query?)`.
- Do not keep compatibility aliases for the older helper family.
- Do not move response/denial/error into the screen reader.

### Step 5: Tests

Add runtime tests for:

- `result.screen.get.message(...)` on command replies.
- `result.screen.get.container(...).get.select(...)` on Components V2.
- `result.screen.get.modal(...)` on modal responses.
- `flow.screen.get.button(...)` on parked dispatches.
- `rendered(builder).get.button(...)` for standalone builder/raw usage.
- `outcome(result).get.response(...)` passes for message replies, defers, modal-only responses, updates, edits, and followups.
- `outcome(result).get.response(...)` throws on no response with a clear diagnostic.
- denial and error outcome readers remain separate and do not appear under `screen`.

Add type tests for:

```ts
result.screen.get.button("retry");
result.screen.get.container({ content: /Settings/i }).get.content({ text: /Client POV/i });

// @ts-expect-error screen is rendered output only
result.screen.get.response();

// @ts-expect-error screen is rendered output only
result.screen.get.denial();

// @ts-expect-error no mini assertion framework
result.screen.has.button("retry");
```

## Stop Conditions

- If the implementation adds `screen.get.response`, `screen.get.denial`, or `screen.get.error`, stop.
- If the implementation adds `single`, `maybe`, `has`, or `none`, stop.
- If `screen` starts a dispatch, awaits a dispatch, or releases a checkpoint, stop.
- If adding `screen` requires duplicating rendered normalization, stop.
- If result snapshots become noisy because `screen` is enumerable, make it non-enumerable or reconsider attaching
  it directly.

## Verification

Run from the repo root:

```sh
pnpm --filter @slipher/testing exec tsc --noEmit --project ./test/tsconfig.json
pnpm --filter @slipher/testing test
```

Expected result after implementation: typecheck passes and the full `@slipher/testing` suite stays green.
