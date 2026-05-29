export type Awaitable<T> = T | Promise<T>;
export type RecordedCall<TArgs extends readonly unknown[]> = TArgs;
export type RecorderImplementation<TArgs extends readonly unknown[], TResult> = (...args: TArgs) => Awaitable<TResult>;

export interface Recorder<TArgs extends readonly unknown[] = readonly unknown[], TResult = unknown> {
	(...args: TArgs): Promise<TResult>;
	readonly calls: RecordedCall<TArgs>[];
	readonly callCount: number;
	readonly lastCall?: RecordedCall<TArgs>;
	implementation?: RecorderImplementation<TArgs, TResult>;
	clear(): void;
	returns(value: TResult): Recorder<TArgs, TResult>;
	resolves(value: Awaited<TResult>): Recorder<TArgs, TResult>;
	mockImplementation(implementation: RecorderImplementation<TArgs, TResult>): Recorder<TArgs, TResult>;
}

export function createRecorder<TArgs extends readonly unknown[] = readonly unknown[], TResult = unknown>(
	implementation?: RecorderImplementation<TArgs, TResult>,
): Recorder<TArgs, TResult> {
	const calls: RecordedCall<TArgs>[] = [];

	const recorder = (async (...args: TArgs) => {
		calls.push(args);
		return recorder.implementation ? await recorder.implementation(...args) : (undefined as TResult);
	}) as Recorder<TArgs, TResult>;

	Object.defineProperties(recorder, {
		calls: {
			get: () => calls,
		},
		callCount: {
			get: () => calls.length,
		},
		lastCall: {
			get: () => calls.at(-1),
		},
	});

	recorder.implementation = implementation;
	recorder.clear = () => {
		calls.length = 0;
	};
	recorder.returns = value => recorder.mockImplementation(() => value);
	recorder.resolves = value => recorder.mockImplementation(() => Promise.resolve(value) as Awaitable<TResult>);
	recorder.mockImplementation = nextImplementation => {
		recorder.implementation = nextImplementation;
		return recorder;
	};

	return recorder;
}
