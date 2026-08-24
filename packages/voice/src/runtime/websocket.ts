export function createRuntimeWebSocket(url: string): WebSocket {
	const Constructor = globalThis.WebSocket;
	if (typeof Constructor !== 'function') {
		throw new TypeError('This runtime does not provide a WebSocket implementation.');
	}
	return new Constructor(url);
}
