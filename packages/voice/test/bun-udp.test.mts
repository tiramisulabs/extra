import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBunUdpSocket } from '../src/runtime/bun-udp';

interface FakeBunConnectedUdpSocket {
	closed: boolean;
	send(data: Uint8Array): boolean;
	close(): void;
}

interface FakeBunUdpSocketHandler {
	data(socket: FakeBunConnectedUdpSocket, data: Uint8Array): void;
	drain(socket: FakeBunConnectedUdpSocket): void;
	error(socket: FakeBunConnectedUdpSocket, error: Error): void;
	close(socket: FakeBunConnectedUdpSocket): void;
}

interface FakeBunRuntime {
	udpSocket(options: { readonly socket: FakeBunUdpSocketHandler }): Promise<FakeBunConnectedUdpSocket>;
}

function installFakeBun(runtime: FakeBunRuntime): void {
	if (originalBun) {
		vi.spyOn(originalBun, 'udpSocket').mockImplementation(runtime.udpSocket);
		return;
	}
	runtimeGlobal.Bun = runtime;
}

const runtimeGlobal = globalThis as typeof globalThis & { Bun?: FakeBunRuntime };
const originalBun = runtimeGlobal.Bun;

async function createHarness(sendResults: readonly boolean[]) {
	const results = [...sendResults];
	const attempts: number[][] = [];
	let handler: FakeBunUdpSocketHandler | undefined;
	const socket: FakeBunConnectedUdpSocket = {
		closed: false,
		send: vi.fn((data: Uint8Array) => {
			attempts.push([...data]);
			return results.shift() ?? true;
		}),
		close: vi.fn(() => {
			socket.closed = true;
		}),
	};
	installFakeBun({
		async udpSocket(options: { readonly socket: FakeBunUdpSocketHandler }) {
			handler = options.socket;
			return socket;
		},
	});
	const onError = vi.fn();
	const onClose = vi.fn();
	const udp = await createBunUdpSocket({
		remoteAddress: '127.0.0.1',
		remotePort: 50_000,
		onMessage: vi.fn(),
		onError,
		onClose,
	});
	if (!handler) throw new Error('The fake Bun runtime did not receive a socket handler.');

	return { attempts, handler, onClose, onError, socket, udp };
}

afterEach(() => {
	vi.restoreAllMocks();
	if (originalBun === undefined) delete runtimeGlobal.Bun;
});

describe('Bun UDP adapter', () => {
	test('resolves a datagram accepted by Bun without retrying it', async () => {
		const harness = await createHarness([true]);

		await expect(harness.udp.send(Uint8Array.of(1, 2, 3))).resolves.toBeUndefined();

		expect(harness.attempts).toEqual([[1, 2, 3]]);
		expect(harness.socket.send).toHaveBeenCalledOnce();
	});

	test('retries backpressured datagrams in FIFO order after each drain', async () => {
		const harness = await createHarness([false, true, false, true]);
		const completions: number[] = [];
		const firstData = Uint8Array.of(1);
		const secondData = Uint8Array.of(2);

		const first = harness.udp.send(firstData).then(() => {
			completions.push(1);
		});
		const second = harness.udp.send(secondData).then(() => {
			completions.push(2);
		});
		firstData[0] = 9;
		secondData[0] = 9;

		expect(harness.attempts).toEqual([[1]]);
		harness.handler.drain(harness.socket);
		await Promise.resolve();

		expect(harness.attempts).toEqual([[1], [1], [2]]);
		expect(completions).toEqual([1]);

		harness.handler.drain(harness.socket);
		await Promise.all([first, second]);
		expect(harness.attempts).toEqual([[1], [1], [2], [2]]);
		expect(completions).toEqual([1, 2]);

		harness.handler.drain(harness.socket);
		expect(harness.socket.send).toHaveBeenCalledTimes(4);
	});

	test('rejects every queued datagram when Bun reports an error', async () => {
		const harness = await createHarness([false]);
		const error = new Error('UDP failed');
		const settled = Promise.allSettled([harness.udp.send(Uint8Array.of(1)), harness.udp.send(Uint8Array.of(2))]);

		harness.handler.error(harness.socket, error);

		expect(await settled).toEqual([
			{ status: 'rejected', reason: error },
			{ status: 'rejected', reason: error },
		]);
		expect(harness.onError).toHaveBeenCalledExactlyOnceWith(error);
		harness.handler.drain(harness.socket);
		expect(harness.socket.send).toHaveBeenCalledOnce();
	});

	test('rejects every queued datagram when Bun closes the socket', async () => {
		const harness = await createHarness([false]);
		const settled = Promise.allSettled([harness.udp.send(Uint8Array.of(1)), harness.udp.send(Uint8Array.of(2))]);
		harness.socket.closed = true;

		harness.handler.close(harness.socket);

		const results = await settled;
		for (const result of results) {
			expect(result.status).toBe('rejected');
			if (result.status === 'rejected') {
				expect(result.reason).toEqual(new Error('The UDP socket closed before its pending writes drained.'));
			}
		}
		expect(harness.onClose).toHaveBeenCalledOnce();
		await expect(harness.udp.send(Uint8Array.of(3))).rejects.toThrow('The UDP socket is closed.');
		harness.handler.drain(harness.socket);
		expect(harness.socket.send).toHaveBeenCalledOnce();
	});

	test('rejects queued datagrams immediately when explicitly closed', async () => {
		const harness = await createHarness([false]);
		const pending = harness.udp.send(Uint8Array.of(1));
		const rejection = expect(pending).rejects.toThrow('The UDP socket closed before its pending writes drained.');

		await harness.udp.close();

		await rejection;
		expect(harness.socket.close).toHaveBeenCalledOnce();
	});
});
