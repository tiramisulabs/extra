import { SeyfertError, type SeyfertErrorCode } from 'seyfert';

export type VoiceErrorCode =
	| 'VOICE_INVALID_ARGUMENT'
	| 'VOICE_NOT_CONNECTED'
	| 'VOICE_MOVE_REQUIRED'
	| 'VOICE_OPERATION_CONFLICT'
	| 'VOICE_OPERATION_TIMEOUT'
	| 'VOICE_CONNECTION_DESTROYED'
	| 'VOICE_CONNECTION_FAILED'
	| 'VOICE_PROTOCOL_ERROR'
	| 'VOICE_RUNTIME_UNSUPPORTED'
	| 'VOICE_VERIFICATION_UNAVAILABLE';

export interface VoiceErrorOptions {
	metadata?: Record<string, unknown>;
	cause?: unknown;
}

export class VoiceError<Code extends VoiceErrorCode = VoiceErrorCode> extends SeyfertError {
	override name = 'VoiceError';
	declare code: Code;

	constructor(code: Code, options?: VoiceErrorOptions) {
		super(code, options);
		this.code = code;
		Error.captureStackTrace?.(this, VoiceError);
	}

	static override is(error: unknown): error is VoiceError;
	static override is<Code extends SeyfertErrorCode>(
		error: unknown,
		code: Code,
	): error is VoiceError & { code: Extract<Code, VoiceErrorCode> };
	static override is(error: unknown, code?: SeyfertErrorCode): error is VoiceError {
		return error instanceof VoiceError && (code === undefined || error.code === code);
	}
}
