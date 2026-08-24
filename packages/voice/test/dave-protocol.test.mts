import { describe, expect, test } from 'vitest';
import { concatenateBytes as concatenate } from '../src/bytes';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import {
	DaveMlsProposalOperation,
	parseDaveExternalSenderPayload,
	parseDaveJsonData,
	parseDaveMlsProposalsPayload,
	parseDaveMlsTransitionPayload,
} from '../src/dave/protocol';
import { MlsWriter } from '../src/mls/codec';

describe('DAVE protocol payloads', () => {
	test('normalizes the documented JSON opcode data', () => {
		expect(parseDaveJsonData(11, { user_ids: ['1', '18446744073709551615'] })).toEqual({
			userIds: ['1', '18446744073709551615'],
		});
		expect(parseDaveJsonData(13, { user_id: '42' })).toEqual({ userId: '42' });
		expect(parseDaveJsonData(21, { protocol_version: 0, transition_id: 10 })).toEqual({
			protocolVersion: 0,
			transitionId: 10,
		});
		expect(parseDaveJsonData(22, { transition_id: 11 })).toEqual({ transitionId: 11 });
		expect(parseDaveJsonData(24, { protocol_version: 1, epoch: 2, transition_id: 12 })).toEqual({
			protocolVersion: 1,
			epoch: 2,
			transitionId: 12,
		});
		expect(parseDaveJsonData(24, { protocol_version: 1, epoch: 1 })).toEqual({
			protocolVersion: 1,
			epoch: 1,
			transitionId: undefined,
		});
	});

	test('parses and validates the external sender package', () => {
		const provider = new VoiceCryptoProvider();
		const signatureKey = provider.getP256PublicKey(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
		const payload = new MlsWriter().vector(signatureKey).uint16(1).vector(Uint8Array.of(0xaa, 0xbb)).finish();

		expect(parseDaveExternalSenderPayload(payload, provider)).toEqual({
			signatureKey,
			credential: { type: 1, identity: Uint8Array.of(0xaa, 0xbb) },
		});
		expect(() =>
			parseDaveExternalSenderPayload(
				new MlsWriter().vector(signatureKey).uint16(2).vector(Uint8Array.of()).finish(),
				provider,
			),
		).toThrow('Basic credential');
		expect(() =>
			parseDaveExternalSenderPayload(
				new MlsWriter().vector(new Uint8Array(65)).uint16(1).vector(Uint8Array.of()).finish(),
				provider,
			),
		).toThrow('P-256');
		expect(() => parseDaveExternalSenderPayload(concatenate(payload, Uint8Array.of(0)), provider)).toThrow('trailing');
	});

	test('parses append and revoke proposal envelopes', () => {
		const encodedProposalMessages = Uint8Array.of(1, 2, 3, 4);
		const append = new MlsWriter().uint8(DaveMlsProposalOperation.Append).vector(encodedProposalMessages).finish();
		expect(parseDaveMlsProposalsPayload(append)).toEqual({ operation: 'append', encodedProposalMessages });

		const firstRef = new Uint8Array(32).fill(0x11);
		const secondRef = new Uint8Array(32).fill(0x22);
		const revoke = new MlsWriter()
			.uint8(DaveMlsProposalOperation.Revoke)
			.vectorWith(writer => writer.vector(firstRef).vector(secondRef))
			.finish();
		expect(parseDaveMlsProposalsPayload(revoke)).toEqual({
			operation: 'revoke',
			proposalRefs: [firstRef, secondRef],
		});
	});

	test('rejects malformed proposal envelopes while preserving opaque ProposalRef lengths', () => {
		expect(() => parseDaveMlsProposalsPayload(Uint8Array.of(2, 0))).toThrow('unsupported operation');
		expect(() => parseDaveMlsProposalsPayload(Uint8Array.of(DaveMlsProposalOperation.Append, 2, 1))).toThrow(
			'truncated',
		);
		const shortRef = new Uint8Array(31);
		expect(
			parseDaveMlsProposalsPayload(
				new MlsWriter()
					.uint8(DaveMlsProposalOperation.Revoke)
					.vectorWith(writer => writer.vector(shortRef))
					.finish(),
			),
		).toEqual({ operation: 'revoke', proposalRefs: [shortRef] });
		expect(() =>
			parseDaveMlsProposalsPayload(
				new MlsWriter().uint8(DaveMlsProposalOperation.Append).vector(Uint8Array.of()).uint8(0).finish(),
			),
		).toThrow('trailing');
	});

	test('parses the shared opcode 29 and 30 transition prefix', () => {
		const encodedMessage = Uint8Array.of(1, 2, 3);
		expect(parseDaveMlsTransitionPayload(new MlsWriter().uint16(0xbeef).bytes(encodedMessage).finish())).toEqual({
			transitionId: 0xbeef,
			encodedMessage,
		});
		expect(() => parseDaveMlsTransitionPayload(Uint8Array.of(1))).toThrow('truncated');
		expect(() => parseDaveMlsTransitionPayload(new MlsWriter().uint16(1).finish())).toThrow('MLS message');
	});
});
