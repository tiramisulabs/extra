import type { Recorder } from './recorder';

export function getLastCall<TArgs extends readonly unknown[]>(
	recorder: Pick<Recorder<TArgs, unknown>, 'lastCall'>,
): TArgs {
	if (!recorder.lastCall) throw new Error('Expected recorder to have been called at least once.');
	return recorder.lastCall;
}

export function getLastResponse<TResponse>(target: { lastResponse(): TResponse | undefined }): TResponse {
	const response = target.lastResponse();
	if (typeof response === 'undefined') throw new Error('Expected context to have at least one response.');
	return response;
}

export function expectCallCount(recorder: Pick<Recorder, 'callCount'>, expected: number): void {
	if (recorder.callCount !== expected) {
		throw new Error(`Expected recorder to be called ${expected} times, received ${recorder.callCount}.`);
	}
}
