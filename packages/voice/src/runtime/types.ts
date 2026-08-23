export interface RuntimeUdpSocketOptions {
	readonly remoteAddress: string;
	readonly remotePort: number;
	readonly onMessage: (data: Uint8Array) => void;
	readonly onError: (error: unknown) => void;
	readonly onClose: () => void;
}

export interface RuntimeUdpSocket {
	send(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export interface VoiceRuntimeAdapter {
	createWebSocket(url: string): WebSocket;
	createUdpSocket(options: RuntimeUdpSocketOptions): Promise<RuntimeUdpSocket>;
	now(): number;
	random(): number;
}

export type RuntimeUdpSocketFactory = (options: RuntimeUdpSocketOptions) => Promise<RuntimeUdpSocket>;
