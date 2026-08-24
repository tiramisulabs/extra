import { createSocket } from 'node:dgram';
import type { RuntimeUdpSocket, RuntimeUdpSocketOptions } from './types';

export function createNodeUdpSocket(options: RuntimeUdpSocketOptions): Promise<RuntimeUdpSocket> {
	const socket = createSocket(options.remoteAddress.includes(':') ? 'udp6' : 'udp4');
	let closed = false;
	let startupSettled = false;

	return new Promise((resolve, reject) => {
		const handleError = (error: Error) => {
			if (!startupSettled) {
				startupSettled = true;
				closed = true;
				closeSocketQuietly(socket);
				reject(error);
				return;
			}
			options.onError(error);
		};

		socket.on('error', handleError);
		socket.on('message', message => options.onMessage(message));
		socket.once('close', () => {
			closed = true;
			if (!startupSettled) {
				startupSettled = true;
				reject(new Error('The UDP socket closed before connecting.'));
			}
			options.onClose();
		});

		try {
			socket.connect(options.remotePort, options.remoteAddress, () => {
				if (startupSettled) return;
				startupSettled = true;
				resolve({
					send(data) {
						if (closed) return Promise.reject(new Error('The UDP socket is closed.'));
						return new Promise<void>((resolveSend, rejectSend) => {
							socket.send(data, error => (error ? rejectSend(error) : resolveSend()));
						});
					},
					close() {
						if (closed) return Promise.resolve();
						return new Promise<void>((resolveClose, rejectClose) => {
							try {
								socket.close(resolveClose);
							} catch (error) {
								rejectClose(error);
							}
						});
					},
				});
			});
		} catch (error) {
			startupSettled = true;
			closed = true;
			closeSocketQuietly(socket);
			reject(error);
		}
	});
}

function closeSocketQuietly(socket: ReturnType<typeof createSocket>): void {
	try {
		socket.close();
	} catch {
		// A socket can fail before Node binds it.
	}
}
