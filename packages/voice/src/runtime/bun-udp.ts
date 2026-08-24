import type { RuntimeUdpSocket, RuntimeUdpSocketOptions } from './types';

interface BunConnectedUdpSocket {
	readonly closed: boolean;
	send(data: Uint8Array): boolean;
	close(): void;
}

interface BunUdpSocketHandler {
	data(socket: BunConnectedUdpSocket, data: Uint8Array): void;
	drain(socket: BunConnectedUdpSocket): void;
	error(socket: BunConnectedUdpSocket, error: Error): void;
	close(socket: BunConnectedUdpSocket): void;
}

interface BunRuntime {
	udpSocket(options: {
		readonly binaryType: 'uint8array';
		readonly connect: { readonly hostname: string; readonly port: number };
		readonly socket: BunUdpSocketHandler;
	}): Promise<BunConnectedUdpSocket>;
}

interface PendingDatagram {
	readonly data: Uint8Array;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

export async function createBunUdpSocket(options: RuntimeUdpSocketOptions): Promise<RuntimeUdpSocket> {
	const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
	if (!bun) throw new TypeError('The Bun UDP API is unavailable.');

	let closed = false;
	let backpressured = false;
	let flushing = false;
	const pendingDatagrams: PendingDatagram[] = [];
	const rejectPending = (error: unknown) => {
		backpressured = false;
		for (const pending of pendingDatagrams.splice(0)) pending.reject(error);
	};
	const enqueue = (data: Uint8Array) =>
		new Promise<void>((resolve, reject) => {
			pendingDatagrams.push({ data: data.slice(), resolve, reject });
		});
	const flushPending = (socket: BunConnectedUdpSocket) => {
		if (closed || backpressured || flushing) return;

		flushing = true;
		try {
			while (pendingDatagrams.length > 0) {
				const pending = pendingDatagrams[0];
				if (!socket.send(pending.data)) {
					backpressured = true;
					return;
				}

				pendingDatagrams.shift();
				pending.resolve();
			}
		} catch (error) {
			rejectPending(error);
		} finally {
			flushing = false;
		}
	};
	const socket = await bun.udpSocket({
		binaryType: 'uint8array',
		connect: { hostname: options.remoteAddress, port: options.remotePort },
		socket: {
			data(_socket, data) {
				options.onMessage(data);
			},
			drain(socket) {
				backpressured = false;
				flushPending(socket);
			},
			error(_socket, error) {
				rejectPending(error);
				options.onError(error);
			},
			close() {
				closed = true;
				const error = new Error('The UDP socket closed before its pending writes drained.');
				rejectPending(error);
				options.onClose();
			},
		},
	});

	return {
		send(data) {
			if (closed || socket.closed) return Promise.reject(new Error('The UDP socket is closed.'));
			if (backpressured || flushing || pendingDatagrams.length > 0) return enqueue(data);
			try {
				if (socket.send(data)) return Promise.resolve();
			} catch (error) {
				return Promise.reject(error);
			}

			backpressured = true;
			return enqueue(data);
		},
		async close() {
			if (closed) return;
			closed = true;
			rejectPending(new Error('The UDP socket closed before its pending writes drained.'));
			if (!socket.closed) socket.close();
		},
	};
}
