import type { DispatchResult } from './bot';
import type { DispatchDenial } from './dispatch-context';

/**
 * Thrown by the `expect*` assertion helpers. Carries no test-runner coupling, so it surfaces the same
 * way under vitest, jest, node:test, or a bare script — the helpers stay runner-agnostic.
 */
export class MockAssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MockAssertionError';
	}
}

const summarize = (result: DispatchResult) => {
	if (result.denied) return `dispatch was denied (${result.denial?.kind ?? 'unknown'})`;
	if (result.error !== undefined) return `dispatch errored (${describeError(result.error)})`;
	return 'dispatch produced no user-visible output';
};

const describeError = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/**
 * Assert that the dispatch produced at least one user-visible reply, edit, or followup. Throws when the
 * handler returned without replying — the case a naive `expect(r.content).toContain(...)` lets pass green
 * because `content` is `undefined`. Returns the result for chaining.
 */
export function expectReply(result: DispatchResult): DispatchResult {
	if (result.replies.length === 0 && result.messages.length === 0) {
		throw new MockAssertionError(`expectReply: no reply was sent — ${summarize(result)}.`);
	}
	return result;
}

/** Expected-denial shape for {@link expectDenied}; every field is optional and checked only when present. */
export interface ExpectedDenial {
	kind?: DispatchDenial['kind'];
	middleware?: string;
	/** Permission names that must all appear in the denial's `missing` list. */
	missing?: string | string[];
}

/**
 * Assert that the dispatch was denied before `run` (middleware stop / no-next, or a permission guard).
 * With `expected`, also asserts the denial's `kind`, `middleware`, and/or `missing` permissions.
 */
export function expectDenied(result: DispatchResult, expected?: ExpectedDenial): DispatchResult {
	if (!result.denied) {
		throw new MockAssertionError(`expectDenied: dispatch was not denied — ${summarize(result)}.`);
	}
	const denial = result.denial;
	if (expected?.kind && denial?.kind !== expected.kind) {
		throw new MockAssertionError(`expectDenied: expected kind "${expected.kind}" but got "${denial?.kind}".`);
	}
	if (expected?.middleware && denial?.middleware !== expected.middleware) {
		throw new MockAssertionError(
			`expectDenied: expected middleware "${expected.middleware}" but got "${denial?.middleware}".`,
		);
	}
	if (expected?.missing) {
		const want = Array.isArray(expected.missing) ? expected.missing : [expected.missing];
		const got = denial?.missing ?? [];
		const absent = want.filter(name => !got.includes(name));
		if (absent.length > 0) {
			throw new MockAssertionError(
				`expectDenied: expected missing permission(s) [${absent.join(', ')}] but denial.missing was [${got.join(', ')}].`,
			);
		}
	}
	return result;
}

/** Matcher for {@link expectError}: a substring, a RegExp, or a predicate over the captured error. */
export type ErrorMatcher = string | RegExp | ((error: unknown) => boolean);

/**
 * Assert that the handler threw an unhandled error captured on the result. Requires
 * `onCommandError: 'capture'` (under the default `'throw'` the dispatch rejects instead, so catch that).
 * With `matcher`, also asserts the error message contains the substring / matches the RegExp / passes the predicate.
 */
export function expectError(result: DispatchResult, matcher?: ErrorMatcher): unknown {
	if (result.error === undefined) {
		throw new MockAssertionError(
			`expectError: no error was captured — ${summarize(result)}. (Did you set onCommandError: 'capture'?)`,
		);
	}
	if (matcher !== undefined && !matchesError(result.error, matcher)) {
		throw new MockAssertionError(`expectError: captured error did not match — got ${describeError(result.error)}.`);
	}
	return result.error;
}

const matchesError = (error: unknown, matcher: ErrorMatcher): boolean => {
	if (typeof matcher === 'function') return matcher(error);
	const message = error instanceof Error ? error.message : String(error);
	return typeof matcher === 'string' ? message.includes(matcher) : matcher.test(message);
};
