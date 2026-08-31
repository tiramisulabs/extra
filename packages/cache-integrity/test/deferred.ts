export function deferred<T = void>() {
	let reject!: (error: unknown) => void;
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, reject, resolve };
}
