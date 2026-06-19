import { AsyncLocalStorage } from 'node:async_hooks';

/** Structured reason a dispatch never reached the command's `run` body. */
export interface DispatchDenial {
	/**
	 * - `stop`: a middleware called `stop(reason)`.
	 * - `pass`: a middleware called `pass()`, short-circuiting the chain so `run` was skipped.
	 * - `no-next`: a middleware replied and returned without calling next/stop/pass.
	 * - `permissions`: the invoking member lacked the command's `defaultMemberPermissions`.
	 * - `bot-permissions`: the bot lacked the command's `botPermissions`.
	 */
	kind: 'stop' | 'pass' | 'no-next' | 'permissions' | 'bot-permissions';
	/** The argument passed to `stop(reason)`, when kind is `stop`. */
	reason?: unknown;
	/** The middleware key that denied, when derivable. */
	middleware?: string;
	/** Missing permission names, when kind is `permissions` / `bot-permissions`. */
	missing?: string[];
}

export interface DispatchContext {
	readonly dispatchId: number;
	componentCommandExecuted: boolean;
	collectorMatched: boolean;
	modalMatched: boolean;
	resolveDenial?: () => void;
	/** Structured denial metadata, set by the middleware/permission wrappers when a denial is detected. */
	denial?: DispatchDenial;
	/** First unhandled error thrown inside the command/component/modal `run`, captured via the onRunError hook. */
	error?: unknown;
	/** True when an author-provided onRunError handled `error`, so the dispatch should not throw on it. */
	errorHandled?: boolean;
}

export const dispatchStore = new AsyncLocalStorage<DispatchContext>();

let nextId = 1;

export function nextDispatchId(): number {
	return nextId++;
}
