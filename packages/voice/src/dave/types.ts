export interface DaveSessionCallbacks {
	readonly sendJson: (opcode: number, data: unknown) => void;
	readonly sendBinary: (opcode: number, data: Uint8Array) => void;
	readonly onReady: () => void;
	readonly onRecovering: () => void;
	readonly onVoicePrivacyCodeChange: (code: string | null) => void;
}

export interface DaveSessionInput {
	readonly channelId: string;
	readonly userId: string;
}

export interface DaveSession {
	readonly maxProtocolVersion: number;
	readonly ready: boolean;
	setProtocolVersion(version: number): void | Promise<void>;
	handleJsonMessage(opcode: number, data: unknown): void | Promise<void>;
	handleBinaryMessage(opcode: number, data: Uint8Array): void | Promise<void>;
	transformAudioFrame(frame: Uint8Array): Uint8Array;
	transformReceivedAudioFrame(userId: string, frame: Uint8Array): Uint8Array | undefined;
	getVerificationCode(userId: string): Promise<string>;
	close(): void | Promise<void>;
}

export type DaveSessionFactory = (input: DaveSessionInput, callbacks: DaveSessionCallbacks) => DaveSession;

/** @internal */
export interface DaveSessionFactoryResource extends DaveSessionFactory {
	retain(): () => void;
	close(): void | Promise<void>;
}
