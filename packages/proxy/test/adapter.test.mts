import type { HttpResponse } from 'uWebSockets.js';
import { describe, expect, test, vi } from 'vitest';
import { readBuffer } from '../src/adapter';

vi.mock('uWebSockets.js', () => ({
	App: vi.fn(),
	getParts: vi.fn(),
}));

describe('readBuffer', () => {
	test('rejects if final Buffer.concat fails after closing the response', async () => {
		let onData: ((chunk: ArrayBuffer, isLast: boolean) => void) | undefined;
		const response = {
			onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void) {
				onData = handler;
				return response;
			},
			onAborted() {
				return response;
			},
			close: vi.fn(),
		} as unknown as HttpResponse;
		const failure = new Error('concat failed');
		const concat = vi.spyOn(Buffer, 'concat').mockImplementation(() => {
			throw failure;
		});

		const pending = readBuffer(response);
		onData?.(new ArrayBuffer(1), true);

		await expect(pending).rejects.toThrow('concat failed');
		expect(response.close).toHaveBeenCalledTimes(1);
		concat.mockRestore();
	});
});
