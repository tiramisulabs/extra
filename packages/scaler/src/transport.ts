import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TlsOptions } from 'node:tls';
import WebSocket, { type ClientOptions, type RawData, WebSocketServer } from 'ws';
import { toError } from './internal';
import { parseProtocolMessage, type ScalerProtocolMessage, stringifyProtocolMessage } from './protocol';

const MAX_PAYLOAD_BYTES = 1_048_576;

export interface WebSocketConnectionOptions {
	host: string;
	port: number;
	hostId: string;
	authToken: string;
	tls?: ClientOptions & { servername?: string };
	allowInsecureTransport?: boolean;
	connectTimeoutMs?: number;
}

export interface WebSocketTransportServerOptions {
	host?: string;
	port?: number;
	tls?: TlsOptions;
	authenticate(request: IncomingMessage): boolean;
}

export class ProtocolConnection extends EventEmitter<{
	close: [code: number, reason: string];
	error: [error: Error];
	message: [message: ScalerProtocolMessage];
	pong: [];
}> {
	constructor(private readonly socket: WebSocket) {
		super();
		socket.on('message', data => this.receive(data));
		socket.on('close', (code, reason) => this.emit('close', code, reason.toString()));
		socket.on('error', error => this.emit('error', error));
		socket.on('pong', () => this.emit('pong'));
	}

	get open() {
		return this.socket.readyState === WebSocket.OPEN;
	}

	async send(message: ScalerProtocolMessage) {
		if (!this.open) throw new Error('Scaler WebSocket is not open');
		const payload = stringifyProtocolMessage(message);
		await new Promise<void>((resolve, reject) => {
			this.socket.send(payload, error => (error ? reject(error) : resolve()));
		});
	}

	ping() {
		if (this.open) this.socket.ping();
	}

	close(code = 1000, reason = 'normal closure') {
		if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(code, reason);
	}

	terminate() {
		this.socket.terminate();
	}

	private receive(data: RawData) {
		try {
			if (Array.isArray(data)) throw new Error('Fragmented protocol payloads are not supported');
			const raw = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data as Buffer);
			this.emit('message', parseProtocolMessage(raw));
		} catch (error) {
			this.emit('error', toError(error));
		}
	}
}

export class WebSocketTransportServer extends EventEmitter<{
	connection: [connection: ProtocolConnection, request: IncomingMessage];
	error: [error: Error];
}> {
	private readonly server: HttpServer;
	private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
	private listening = false;

	constructor(private readonly options: WebSocketTransportServerOptions) {
		super();
		this.server = options.tls ? createHttpsServer(options.tls) : createHttpServer();
		this.server.on('upgrade', (request, socket, head) => {
			if (!options.authenticate(request)) {
				socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
				return;
			}
			this.webSockets.handleUpgrade(request, socket, head, webSocket => {
				this.webSockets.emit('connection', webSocket, request);
			});
		});
		this.server.on('error', error => this.emit('error', error));
		this.webSockets.on('connection', (socket, request) => {
			this.emit('connection', new ProtocolConnection(socket), request);
		});
		this.webSockets.on('error', error => this.emit('error', error));
	}

	listen() {
		if (this.listening) return Promise.resolve(this.server.address());
		return new Promise<AddressInfo | string | null>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			this.server.once('error', onError);
			this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
				this.server.off('error', onError);
				this.listening = true;
				resolve(this.server.address());
			});
		});
	}

	async close() {
		if (!this.listening) return;
		for (const socket of this.webSockets.clients) socket.terminate();
		await new Promise<void>((resolve, reject) => {
			this.webSockets.close(error => {
				if (error) return reject(error);
				this.server.close(serverError => (serverError ? reject(serverError) : resolve()));
			});
		});
		this.listening = false;
	}
}

export async function connectWebSocket(options: WebSocketConnectionOptions, signal?: AbortSignal) {
	if (!options.tls && !options.allowInsecureTransport && !isLoopbackHost(options.host)) {
		throw new Error('Remote scaler connections require TLS unless allowInsecureTransport is true');
	}
	if (signal?.aborted) throw abortError(signal);
	const protocol = options.tls ? 'wss' : 'ws';
	const url = `${protocol}://${urlHost(options.host)}:${options.port}`;
	const socket = new WebSocket(url, {
		...options.tls,
		headers: {
			...options.tls?.headers,
			authorization: `Bearer ${options.authToken}`,
			'x-scaler-host-id': options.hostId,
		},
		handshakeTimeout: options.connectTimeoutMs ?? 10_000,
		maxPayload: MAX_PAYLOAD_BYTES,
	});
	return await new Promise<ProtocolConnection>((resolve, reject) => {
		const onAbort = () => {
			socket.terminate();
			reject(abortError(signal!));
		};
		const cleanup = () => signal?.removeEventListener('abort', onAbort);
		signal?.addEventListener('abort', onAbort, { once: true });
		socket.once('open', () => {
			cleanup();
			resolve(new ProtocolConnection(socket));
		});
		socket.once('error', error => {
			cleanup();
			reject(error);
		});
	});
}

export function bearerToken(request: IncomingMessage) {
	const authorization = request.headers.authorization;
	return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
}

export function isLoopbackHost(host: string) {
	const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
	return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function urlHost(host: string) {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function abortError(signal: AbortSignal) {
	const error = new Error('Scaler connection aborted', { cause: signal.reason });
	error.name = 'AbortError';
	return error;
}
