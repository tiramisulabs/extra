/** @internal */
export type DaveVerificationErrorReason = 'participant_not_present' | 'participant_changed' | 'derivation_failed';

/** @internal */
export class DaveVerificationError extends Error {
	readonly reason: DaveVerificationErrorReason;

	constructor(reason: DaveVerificationErrorReason, options?: ErrorOptions) {
		super(verificationErrorMessage(reason), options);
		this.name = 'DaveVerificationError';
		this.reason = reason;
		Error.captureStackTrace?.(this, DaveVerificationError);
	}
}

function verificationErrorMessage(reason: DaveVerificationErrorReason): string {
	switch (reason) {
		case 'participant_not_present':
			return 'The requested DAVE participant is unavailable.';
		case 'participant_changed':
			return 'The requested DAVE participant changed during verification.';
		case 'derivation_failed':
			return 'The DAVE verification code derivation failed.';
	}
}
