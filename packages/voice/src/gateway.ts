import {
	type GatewayDispatchPayload,
	GatewayOpcodes,
	type GatewayVoiceServerUpdateDispatchData,
	type GatewayVoiceStateUpdate,
	type GatewayVoiceStateUpdateDispatchData,
} from 'seyfert';
import { VoiceError } from './errors';
import type { VoiceConfirmedState } from './types';

interface GatewaySender {
	calculateShardId(guildId: string): number;
	send(shardId: number, payload: GatewayVoiceStateUpdate): Promise<boolean>;
}

export interface VoiceGatewayClient {
	me?: { id?: unknown };
	gateway?: Partial<GatewaySender>;
	calculateShardId?(guildId: string): number;
	sendGatewayPayload?(shardId: number, payload: GatewayVoiceStateUpdate): Promise<boolean>;
}

export interface VoiceGatewayStateObservation {
	readonly kind: 'state';
	readonly shardId: number;
	readonly guildId: string;
	readonly sessionId: string;
	readonly confirmed: VoiceConfirmedState | null;
}

export interface VoiceGatewayServerObservation {
	readonly kind: 'server';
	readonly shardId: number;
	readonly guildId: string;
	readonly token: string;
	readonly endpoint: string | null;
}

export type VoiceGatewayObservation = VoiceGatewayStateObservation | VoiceGatewayServerObservation;

export function getGatewayClientUserId(client: VoiceGatewayClient): string {
	const userId = client.me?.id;
	if (typeof userId !== 'string') {
		throw new VoiceError('VOICE_CONNECTION_FAILED', {
			metadata: { detail: 'The Seyfert client must be ready before connecting to voice.', reason: 'client-not-ready' },
		});
	}
	return userId;
}

export async function sendGatewayVoiceState(
	client: VoiceGatewayClient,
	input: {
		guildId: string;
		channelId: string | null;
		selfMute: boolean;
		selfDeaf: boolean;
	},
): Promise<boolean> {
	const payload: GatewayVoiceStateUpdate = {
		op: GatewayOpcodes.VoiceStateUpdate,
		d: {
			guild_id: input.guildId,
			channel_id: input.channelId,
			self_mute: input.selfMute,
			self_deaf: input.selfDeaf,
		},
	};

	if (typeof client.gateway?.calculateShardId === 'function' && typeof client.gateway.send === 'function') {
		const shardId = client.gateway.calculateShardId(input.guildId);
		return client.gateway.send(shardId, payload);
	}

	if (typeof client.calculateShardId === 'function' && typeof client.sendGatewayPayload === 'function') {
		const shardId = client.calculateShardId(input.guildId);
		return client.sendGatewayPayload(shardId, payload);
	}

	throw new VoiceError('VOICE_RUNTIME_UNSUPPORTED', {
		metadata: {
			detail: 'Voice requires a Seyfert Client or a WorkerClient with sendGatewayPayload().',
			reason: 'gateway-send-unavailable',
		},
	});
}

export function parseVoiceGatewayObservation(
	packet: GatewayDispatchPayload,
	clientUserId: string,
	shardId: number,
): VoiceGatewayObservation | null {
	if (packet.t === 'VOICE_STATE_UPDATE') {
		const data: GatewayVoiceStateUpdateDispatchData = packet.d;
		if (data.user_id !== clientUserId) return null;
		if (data.guild_id === undefined) {
			throw new VoiceError('VOICE_PROTOCOL_ERROR', {
				metadata: { detail: 'A voice state update must belong to a guild.' },
			});
		}
		return {
			kind: 'state',
			shardId,
			guildId: data.guild_id,
			sessionId: data.session_id,
			confirmed:
				data.channel_id === null
					? null
					: {
							channelId: data.channel_id,
							mute: data.mute,
							deaf: data.deaf,
							selfMute: data.self_mute,
							selfDeaf: data.self_deaf,
							suppress: data.suppress,
							requestToSpeakTimestamp: data.request_to_speak_timestamp,
						},
		};
	}

	if (packet.t === 'VOICE_SERVER_UPDATE') {
		const data: GatewayVoiceServerUpdateDispatchData = packet.d;
		return {
			kind: 'server',
			shardId,
			guildId: data.guild_id,
			token: data.token,
			endpoint: data.endpoint,
		};
	}

	return null;
}
