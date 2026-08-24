import { describe, expect, it } from 'vitest';
import {
	authenticationTokensEqual,
	ProtocolValidationError,
	parseProtocolMessage,
	SCALER_PROTOCOL_VERSION,
	stringifyProtocolMessage,
} from '../src/protocol';

describe('scaler protocol', () => {
	it('round-trips JSON messages', () => {
		const message = {
			type: 'HELLO_ACK' as const,
			version: SCALER_PROTOCOL_VERSION,
			masterId: 'master-1',
		};
		expect(parseProtocolMessage(stringifyProtocolMessage(message))).toEqual(message);
	});

	it('rejects unknown protocol versions', () => {
		expect(() => parseProtocolMessage('{"type":"HELLO_ACK","version":2,"masterId":"master"}')).toThrow(
			ProtocolValidationError,
		);
	});

	it('rejects invalid shard topology', () => {
		expect(() =>
			parseProtocolMessage(
				JSON.stringify({
					type: 'WORKER_STATUS',
					version: 1,
					workerId: 0,
					identity: { slot: 'slot', token: 'token' },
					topology: { shardStart: 2, shardEnd: 2, totalShards: 2 },
					status: 'ready',
				}),
			),
		).toThrow(/shardStart must be lower/);
	});

	it('compares authentication tokens without requiring equal input lengths', () => {
		expect(authenticationTokensEqual('secret', 'secret')).toBe(true);
		expect(authenticationTokensEqual('short', 'a much longer secret')).toBe(false);
	});

	it('rejects values JSON cannot encode', () => {
		expect(() =>
			stringifyProtocolMessage({
				type: 'WORKER_MSG',
				version: 1,
				workerId: 0,
				identity: { slot: 'slot', token: 'token' },
				body: 1n,
			}),
		).toThrow(/not JSON-serializable/);
	});
});
