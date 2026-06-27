# 011 - Outcome Reader

Status: Proposed
Date: 2026-06-27
Scope: `packages/testing`

## Decision

Replace the standalone result-check helpers with a reader-style interface:

```ts
outcome(result).get.response();
outcome(result).get.denial({ kind: "permissions", missing: "BanMembers" });
outcome(result).get.error(/timeout/i);
```

`outcome(...)` mirrors the shape of `rendered(...)`, but it reads a different module interface:

- `rendered(subject)` inspects rendered Discord output: messages, embeds, modals, buttons, selects, inputs,
  containers, content, sections, media, and raw rendered bodies.
- `outcome(result)` inspects dispatch outcome: whether the dispatch responded, was denied, or captured an
  unhandled error.

Do not add `rendered(result).get.response()`, `rendered(result).get.denial()`, or
`rendered(result).get.error()`. Those are not rendered Discord objects.

Do not keep the older standalone result-check helper family or add new helper aliases. The helper family goes away;
there are no deprecated wrappers or aliases.

Do not update `README.md` unless explicitly requested.

## Public Shape

```ts
export function outcome(result: DispatchResult): OutcomeReader;

export type OutcomeReaderMode = "get" | "query" | "all";

export interface OutcomeReader {
  readonly raw: OutcomeRaw;
  readonly get: OutcomeFinder<"get">;
  readonly query: OutcomeFinder<"query">;
  readonly all: OutcomeFinder<"all">;
  debug(): string;
}

export interface OutcomeRaw {
  result(): DispatchResult;
}

export interface OutcomeFinder<Mode extends OutcomeReaderMode> {
  response(query?: ResponseQuery): OutcomeResult<Mode, OutcomeResponse>;
  denial(query?: DenialQuery): OutcomeResult<Mode, OutcomeDenial>;
  error(query?: ErrorQuery | ErrorMatcher): OutcomeResult<Mode, OutcomeCapturedError>;
}

export type OutcomeResult<Mode extends OutcomeReaderMode, View> =
  Mode extends "get" ? View :
  Mode extends "query" ? View | undefined :
  readonly View[];
```

`get.*` throws an `OutcomeError` when there is no matching outcome. `query.*` returns `undefined`.
`all.*` returns `[]` or `[view]`. The `all` surface exists for symmetry with `rendered(...)`, even though
outcome categories are singular by design.

## Type Safety

The reader must preserve the same type-safety expectations as `rendered(...)`:

- `get.*` returns the concrete view.
- `query.*` returns the concrete view or `undefined`.
- `all.*` returns a readonly array of concrete views.
- Query object keys are closed; misspelled object-literal keys must fail at compile time.
- Query enum/string domains are closed; unsupported response kinds and denial kinds must fail at compile time.
- `denial({ missing })` accepts a string or readonly string array.
- `error(...)` accepts an `ErrorQuery` object or a direct `ErrorMatcher`.

Expected inference:

```ts
const state = outcome(result);

const response = state.get.response();
response.events;

const maybeResponse = state.query.response();
if (maybeResponse) maybeResponse.deferred;

const responses = state.all.response();
responses.map(response => response.kind);

const denial = state.get.denial();
denial.denialKind;

const captured = state.get.error();
captured.error;
```

Type tests should live beside the existing rendered-output type checks, likely in `packages/testing/test/types.ts`:

```ts
outcome(result).get.response({ kind: "modal" });
outcome(result).get.response({ ephemeral: true });
outcome(result).get.denial({ kind: "permissions", missing: ["BanMembers"] as const });
outcome(result).get.error(/timeout/i);
outcome(result).get.error({ match: error => error instanceof Error });

// @ts-expect-error - unknown response query keys are rejected.
outcome(result).get.response({ deferredReply: true });

// @ts-expect-error - response kinds are closed.
outcome(result).get.response({ kind: "deferred" });

// @ts-expect-error - unknown denial query keys are rejected.
outcome(result).get.denial({ permission: "BanMembers" });

// @ts-expect-error - denial kinds are closed over DispatchDenial["kind"].
outcome(result).get.denial({ kind: "permission" });

// @ts-expect-error - unknown error query keys are rejected.
outcome(result).get.error({ message: /timeout/i });
```

Do not type the query parameters as loose `Record<string, unknown>` in the public interface. Runtime unknown-key
diagnostics are still useful, but they are a second line of defense for dynamic values, not the main type contract.

## Response View

`response` means the dispatch acknowledged/responded/produced interaction output. It does not mean there is a
visible message.

```ts
export type ResponseKind =
  | "reply"
  | "defer"
  | "deferReply"
  | "deferUpdate"
  | "update"
  | "modal"
  | "autocomplete"
  | "edit"
  | "followup";

export interface ResponseQuery {
  kind?: ResponseKind;
  ephemeral?: boolean;
}

export interface OutcomeResponse {
  readonly kind: "response";
  readonly deferred: boolean;
  readonly deferredReply: boolean;
  readonly deferredUpdate: boolean;
  readonly ephemeral: boolean;
  readonly modal?: { customId?: string; title?: string };
  readonly events: readonly OutcomeResponseEvent[];
  readonly raw: {
    readonly replies: readonly CapturedReply[];
    readonly edits: readonly OutgoingMessage[];
    readonly followups: readonly OutgoingMessage[];
  };
}

export interface OutcomeResponseEvent {
  readonly kind:
    | "reply"
    | "deferReply"
    | "deferUpdate"
    | "update"
    | "modal"
    | "autocomplete"
    | "edit"
    | "followup";
  readonly path: string;
  readonly ephemeral?: boolean;
  readonly raw: unknown;
}
```

Response matching rules:

- `response()` matches if there is at least one response event.
- `kind: "defer"` matches either `deferReply` or `deferUpdate`.
- `kind: "reply"` matches immediate channel-message callbacks.
- `kind: "update"` matches immediate message-update callbacks.
- `kind: "modal"` matches modal callbacks. The modal fields are inspected through `rendered(result)`.
- `kind: "autocomplete"` matches autocomplete callbacks.
- `kind: "edit"` matches original-response or webhook-message edits.
- `kind: "followup"` matches followup messages.
- `ephemeral` checks only the immediate response, matching the current `DispatchResult.ephemeral` contract.
  For rendered message visibility, use `rendered(result).get.message({ ephemeral: true })`.

## Denial View

```ts
export interface DenialQuery {
  kind?: DispatchDenial["kind"];
  middleware?: string;
  missing?: string | readonly string[];
}

export interface OutcomeDenial {
  readonly kind: "denial";
  readonly denialKind: DispatchDenial["kind"];
  readonly reason?: unknown;
  readonly middleware?: string;
  readonly missing: readonly string[];
  readonly raw: DispatchDenial;
}
```

Denial matching rules:

- `denial()` matches when `result.denied === true`.
- `kind`, `middleware`, and `missing` match the existing `DispatchDenial` fields.
- `missing` requires every requested permission to be present in `denial.missing`.
- A denied dispatch may also have a rendered message. Use both readers when both facts matter.

Example:

```ts
const result = await bot.slash({ name: "admin" });

outcome(result).get.denial({ kind: "permissions", missing: "BanMembers" });
rendered(result).get.message({ content: /missing permission/i });
```

## Error View

```ts
export type ErrorMatcher = string | RegExp | ((error: unknown) => boolean);

export interface ErrorQuery {
  match?: ErrorMatcher;
}

export interface OutcomeCapturedError {
  readonly kind: "error";
  readonly error: unknown;
}
```

Error matching rules:

- `error()` matches when `result.error !== undefined`.
- A string matcher checks whether the error message contains the string.
- A `RegExp` matcher checks the error message.
- A predicate matcher receives the raw captured error.
- `outcome(result).get.error(...)` is only useful when `createMockBot({ onCommandError: "capture" })` was used.
  With the default `onCommandError: "throw"`, the dispatch rejects and there is no `DispatchResult` to inspect.

Example:

```ts
const result = await bot.slash({ name: "broken" });

outcome(result).get.response({ kind: "reply" });
outcome(result).get.error(/already replied/i);
rendered(result).get.message({ content: "first" });
```

## Usage Examples

Common visible reply:

```ts
const result = await bot.slash({ name: "ping" });

outcome(result).get.response({ kind: "reply" });
rendered(result).get.message({ content: "pong" });
```

Defer-only response:

```ts
const result = await bot.slash({ name: "sync" });

outcome(result).get.response({ kind: "deferReply" });
expect(rendered(result).all.message()).toHaveLength(0);
```

Modal-only response:

```ts
const result = await bot.slash({ name: "setup" });

outcome(result).get.response({ kind: "modal" });
rendered(result).get.modal("setup-modal");
```

Denied dispatch with rendered denial copy:

```ts
const result = await bot.slash({ name: "ban" });

outcome(result).get.denial({ kind: "permissions", missing: "BanMembers" });
outcome(result).get.response({ kind: "reply" });
rendered(result).get.message({ content: /missing permission/i });
```

Component defer/update:

```ts
const result = await bot.clickButton("next");

outcome(result).get.response({ kind: "deferUpdate" });
outcome(result).get.response({ kind: "edit" });
rendered(result).get.message({ content: /page 2/i });
```

Error captured after partial output:

```ts
const result = await bot.slash({ name: "twice" });

outcome(result).get.response({ kind: "reply" });
outcome(result).get.error(/already replied/i);
rendered(result).get.message({ content: "first" });
```

Absence checks stay in the user's test runner:

```ts
expect(outcome(result).query.error()).toBeUndefined();
expect(outcome(result).all.denial()).toHaveLength(0);
expect(rendered(result).all.button("save")).toHaveLength(1);
```

## Diagnostics

Diagnostics should mirror the directness of `rendered(...)`, but remain outcome-oriented.

Missing response:

```txt
outcome(result).get.response() found 0 responses.

Outcome:
  denied permissions missing=[BanMembers]
  rendered messages=1

If the denial is the contract, use:
  outcome(result).get.denial({ kind: "permissions" })

If the rendered UI is the contract, use:
  rendered(result).get.message(...)
```

Wrong response kind:

```txt
outcome(result).get.response({ kind: "modal" }) found 0 responses.

Responses recorded:
  response reply ephemeral=false
```

Missing error:

```txt
outcome(result).get.error() found 0 errors.

Outcome:
  response reply

If you expected an unhandled command error, create the bot with:
  createMockBot({ onCommandError: "capture" })
```

Unknown query key:

```txt
outcome(result).get.response(...) received unknown query key "deferredReply".
Known response query keys: kind, ephemeral.
```

Use an `OutcomeError` class with structured details, similar in spirit to `RenderedOutputError`.

## Implementation Notes

- Add a new module such as `packages/testing/src/outcome/index.ts` or `packages/testing/src/bot/outcome.ts`.
- Export `outcome`, its query/view types, and `OutcomeError` from the public barrel.
- Remove the older standalone result-check helper family and its assertion error class from the public surface.
- Delete or rewrite tests that import the old helpers.
- Update the public-surface snapshot.
- Do not add deprecated aliases.
- Do not touch `README.md` unless explicitly requested.
- Do not mix rendered-output logic into `outcome(...)`; only use `rendered(...)` in diagnostics when suggesting
  next steps to the caller.

## Test Coverage

Add focused tests for:

- `outcome(result).get.response()` passes for immediate reply.
- `response({ kind: "deferReply" })` passes for defer-only and rendered messages can still be absent.
- `response({ kind: "deferUpdate" })` passes for component defer update.
- `response({ kind: "modal" })` passes for modal-only response.
- `response({ kind: "edit" })` and `response({ kind: "followup" })` pass for edits/followups.
- `response({ kind: "autocomplete" })` passes for autocomplete dispatches if `AutocompleteResult` is accepted.
- `denial(...)` matches `kind`, `middleware`, and `missing`.
- Denied dispatches can also assert rendered messages through `rendered(result)`.
- `error(...)` matches captured errors under `onCommandError: "capture"`.
- Default `onCommandError: "throw"` is documented by tests as a rejected dispatch, not an `outcome(...)` result.
- `query.*` returns `undefined` instead of throwing.
- `all.*` returns `[]` or `[view]`.
- Unknown query keys throw directed `OutcomeError`s.
- Public surface snapshot includes `outcome` and excludes the old helper names.

## Verification

Run:

```sh
pnpm --filter @slipher/testing exec tsc --noEmit --project ./test/tsconfig.json
pnpm --filter @slipher/testing test
```
