import { SeyfertError, type SeyfertErrorCode } from 'seyfert';

export type PlayerErrorCode =
	| 'PLAYER_INVALID_ARGUMENT'
	| 'PLAYER_DESTROYED'
	| 'PLAYER_PROVIDER_NOT_FOUND'
	| 'PLAYER_OPERATION_UNSUPPORTED'
	| 'PLAYER_MEDIA_FAILED';

export interface PlayerErrorOptions {
	metadata?: Record<string, unknown>;
	cause?: unknown;
}

export class PlayerError<Code extends PlayerErrorCode = PlayerErrorCode> extends SeyfertError {
	override name = 'PlayerError';
	declare code: Code;

	constructor(code: Code, options?: PlayerErrorOptions) {
		super(code, options);
		this.code = code;
		Error.captureStackTrace?.(this, PlayerError);
	}

	static override is(error: unknown): error is PlayerError;
	static override is<Code extends SeyfertErrorCode>(
		error: unknown,
		code: Code,
	): error is PlayerError & { code: Extract<Code, PlayerErrorCode> };
	static override is(error: unknown, code?: SeyfertErrorCode): error is PlayerError {
		return error instanceof PlayerError && (code === undefined || error.code === code);
	}
}
