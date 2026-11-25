/** A value that is returned directly by a synchronous adapter and as a promise by an asynchronous one. */
export type Awaitable<T> = T | Promise<T>;

export function isThenable<T>(value: unknown): value is PromiseLike<T> {
	return (
		((typeof value === 'object' && value !== null) || typeof value === 'function') &&
		typeof Reflect.get(value, 'then') === 'function'
	);
}

/** Returns a locally decided result the way the adapter returns its own: directly, or as a promise. */
export function like<T>(adapter: { readonly isAsync: boolean }, value: T): Awaitable<T> {
	return adapter.isAsync ? Promise.resolve(value) : value;
}

/** Continues after `value` without turning a synchronous result into a promise. */
export function map<T, R>(value: T | PromiseLike<T>, next: (value: T) => R | PromiseLike<R>): Awaitable<R> {
	if (isThenable<T>(value)) return Promise.resolve(value).then(next);
	const result = next(value);
	return isThenable<R>(result) ? Promise.resolve(result) : result;
}

/**
 * Runs an operation that may throw synchronously, reject, or return directly, and reports exactly one outcome.
 * `failed` runs before the original error is rethrown or rejected.
 */
export function settle<T>(
	run: () => T | PromiseLike<T>,
	done: (value: T) => void,
	failed: (error: unknown) => void,
): Awaitable<T> {
	let result: T | PromiseLike<T>;
	try {
		result = run();
	} catch (error) {
		failed(error);
		throw error;
	}
	if (!isThenable<T>(result)) {
		done(result);
		return result;
	}
	return Promise.resolve(result).then(
		value => {
			done(value);
			return value;
		},
		error => {
			failed(error);
			throw error;
		},
	);
}
