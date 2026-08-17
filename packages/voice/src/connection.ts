import { VoiceError } from './errors';
import { type VoicePlayback, type VoicePlaybackSource } from './media/playback';
import { type VoiceReceiveOptions, VoiceReceiveStream } from './media/receiver';
import { freezeVoiceState } from './state';
import type { VoiceConnectionState, VoiceSelfStateOptions } from './types';
import { assertSnowflake, resolveSelfStateInput } from './validation';

interface VoiceConnectionActions {
	play(connection: VoiceConnection, source: VoicePlaybackSource): VoicePlayback;
	receive(connection: VoiceConnection, userId: string, options: VoiceReceiveOptions): VoiceReceiveStream;
	setSelfState(connection: VoiceConnection, options: VoiceSelfStateOptions): Promise<void>;
	getVerificationCode(connection: VoiceConnection, userId: string): Promise<string>;
}

/** @internal */
export interface VoiceConnectionController {
	readonly connection: VoiceConnection;
	setState(state: VoiceConnectionState): {
		readonly next: VoiceConnectionState;
		readonly previous: VoiceConnectionState;
	};
	setVoicePrivacyCode(code: string | null): { readonly next: string | null; readonly previous: string | null } | null;
}

export class VoiceConnection {
	readonly guildId: string;
	readonly #actions: VoiceConnectionActions;
	#state: VoiceConnectionState;
	#voicePrivacyCode: string | null = null;

	private constructor(guildId: string, state: VoiceConnectionState, actions: VoiceConnectionActions) {
		this.guildId = guildId;
		this.#state = freezeVoiceState(state);
		this.#actions = actions;
	}

	get state(): VoiceConnectionState {
		return this.#state;
	}

	/** The last voice channel Discord confirmed for this connection, or `null` before the first confirmation. */
	get channelId(): string | null {
		return this.#state.confirmed?.channelId ?? null;
	}

	get voicePrivacyCode(): string | null {
		return this.#voicePrivacyCode;
	}

	play(source: VoicePlaybackSource): VoicePlayback {
		this.assertAlive();
		return this.#actions.play(this, source);
	}

	/** Subscribes to complete encoded Opus packets from one participant. The bot must not be self-deafened. */
	receive(userId: string, options: VoiceReceiveOptions = {}): VoiceReceiveStream {
		this.assertAlive();
		assertSnowflake(userId, 'userId');
		return this.#actions.receive(this, userId, options);
	}

	async setSelfState(options: VoiceSelfStateOptions): Promise<void> {
		this.assertAlive();
		await this.#actions.setSelfState(this, resolveSelfStateInput(options));
	}

	async getVerificationCode(userId: string): Promise<string> {
		this.assertAlive();
		assertSnowflake(userId, 'userId');
		return this.#actions.getVerificationCode(this, userId);
	}

	private assertAlive(): void {
		if (this.#state.status !== 'destroyed') return;
		throw new VoiceError('VOICE_CONNECTION_DESTROYED', {
			metadata: { guildId: this.guildId, status: this.#state.status },
		});
	}

	/** @internal */
	static create(
		guildId: string,
		state: VoiceConnectionState,
		actions: VoiceConnectionActions,
	): VoiceConnectionController {
		const connection = new VoiceConnection(guildId, state, actions);
		return {
			connection,
			setState(nextState) {
				const previous = connection.#state;
				const next = freezeVoiceState(nextState);
				connection.#state = next;
				return { next, previous };
			},
			setVoicePrivacyCode(code) {
				if (code !== null && !/^\d{30}$/.test(code)) {
					throw new VoiceError('VOICE_PROTOCOL_ERROR', {
						metadata: { detail: 'DAVE voice privacy codes must contain exactly 30 ASCII digits.' },
					});
				}
				const previous = connection.#voicePrivacyCode;
				if (code === previous) return null;
				connection.#voicePrivacyCode = code;
				return { next: code, previous };
			},
		};
	}
}
