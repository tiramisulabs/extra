import { describe, expect, test, vi } from 'vitest';
import { concatenateBytes } from '../src/bytes';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { DaveMlsProposalOperation } from '../src/dave/protocol';
import { createDaveSessionFactory } from '../src/dave/session';
import type { DaveSessionFactoryResource, DaveSessionInput } from '../src/dave/types';
import { encodeSnowflakeBigEndian } from '../src/dave/verification';
import { DaveVerificationError } from '../src/dave/verification-error';
import { MlsWriter } from '../src/mls/codec';
import { createExternalProposalPublicMessage, proposalReference } from '../src/mls/handshake';
import {
	CredentialType,
	decodeKeyPackage,
	decodeMlsMessage,
	decodeWelcome,
	encodeMlsMessage,
	type MlsExternalSender,
	type MlsKeyPackage,
	ProposalType,
	ProtocolVersion,
	WireFormat,
} from '../src/mls/protocol';

const provider = new VoiceCryptoProvider();
const CHANNEL_ID = '555555555555555555';
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';

describe('DAVE session engine', () => {
	test('accepts opcode 25 before Session Description and emits a fresh KeyPackage for each join trigger', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await harness.session.handleBinaryMessage(25, encodeExternalSender(external.sender));
			expect(harness.binary).not.toHaveBeenCalled();

			await harness.session.setProtocolVersion(1);
			await harness.session.handleJsonMessage(24, {
				protocol_version: 1,
				epoch: 1,
				transition_id: 41,
			});

			const keyPackages = binaryPayloads(harness.binary, 26);
			expect(keyPackages).toHaveLength(2);
			expect(keyPackages[0]?.subarray(0, 4)).toEqual(Uint8Array.of(0, 1, 0, 2));
			const first = readKeyPackage(keyPackages[0] as Uint8Array);
			const second = readKeyPackage(keyPackages[1] as Uint8Array);
			expect(second.leafNode.signatureKey).toEqual(first.leafNode.signatureKey);
			expect(second.leafNode.encryptionKey).not.toEqual(first.leafNode.encryptionKey);
			expect(second.initKey).not.toEqual(first.initKey);
			expect(harness.json).not.toHaveBeenCalledWith(23, expect.anything());
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('keeps the transport context ready while the initial DAVE group is pending', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await harness.session.handleBinaryMessage(25, encodeExternalSender(external.sender));
			await harness.session.setProtocolVersion(1);

			expect(harness.session.ready).toBe(true);
			const frame = Uint8Array.of(0xf8, 0xff, 0xfe);
			const passthrough = harness.session.transformAudioFrame(frame);
			expect(passthrough).toEqual(frame);
			expect(passthrough).not.toBe(frame);
			expect(harness.recovering).not.toHaveBeenCalled();
			expect(harness.binary).toHaveBeenCalledWith(26, expect.any(Uint8Array));
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('upgrades from v0 through epoch preparation and executes transition zero without acknowledging it', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await harness.session.handleBinaryMessage(25, encodeExternalSender(external.sender));
			await harness.session.handleJsonMessage(24, { protocol_version: 1, epoch: 1, transition_id: 0 });
			expect(harness.session.ready).toBe(true);
			expect(harness.binary).toHaveBeenCalledWith(26, expect.any(Uint8Array));

			await harness.session.handleJsonMessage(21, { protocol_version: 1, transition_id: 0 });

			expect(harness.session.ready).toBe(true);
			const encrypted = harness.session.transformAudioFrame(Uint8Array.of(1, 2, 3));
			expect(encrypted.byteLength).toBeGreaterThan(3);
			expect(encrypted.at(-4)).toBe(1);
			expect(encrypted.subarray(-2)).toEqual(Uint8Array.of(0xfa, 0xfa));
			await harness.session.handleJsonMessage(21, { protocol_version: 1, transition_id: 0 });
			const afterDuplicate = harness.session.transformAudioFrame(Uint8Array.of(1, 2, 3));
			expect(afterDuplicate.at(-4)).toBe(2);
			expect(harness.json).not.toHaveBeenCalledWith(23, expect.anything());
			expect(harness.privacy).toHaveBeenLastCalledWith(null);
			await expect(harness.session.getVerificationCode(USER_A)).rejects.toThrow('unavailable');
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('acknowledges a nonzero downgrade and changes the sending context only on execution', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await establishSoleMember(harness, external.sender);
			await harness.session.handleJsonMessage(21, { protocol_version: 0, transition_id: 7 });

			expect(harness.json).toHaveBeenCalledWith(23, { transition_id: 7 });
			expect(harness.session.ready).toBe(true);

			await harness.session.handleJsonMessage(22, { transition_id: 7 });
			expect(harness.session.ready).toBe(true);
			expect(harness.privacy).toHaveBeenLastCalledWith(null);
			await expect(harness.session.handleJsonMessage(22, { transition_id: 7 })).rejects.toThrow('unknown');
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('treats a repeated prepare transition as idempotent and rejects conflicting reuse', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await establishSoleMember(harness, external.sender);
			await harness.session.handleJsonMessage(21, { protocol_version: 0, transition_id: 8 });
			await harness.session.handleJsonMessage(21, { protocol_version: 0, transition_id: 8 });
			expect(harness.json.mock.calls.filter(call => call[0] === 23 && call[1]?.transition_id === 8)).toHaveLength(1);

			await expect(harness.session.handleJsonMessage(21, { protocol_version: 1, transition_id: 8 })).rejects.toThrow(
				'conflicting',
			);
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('resets MLS verification while epoch one creates a fresh pending group without an acknowledgement', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			const keyPackagesBefore = binaryPayloads(pair.a.binary, 26).length;
			const transitionReadyBefore = pair.a.json.mock.calls.filter(call => call[0] === 23).length;
			await expect(pair.a.session.getVerificationCode(USER_B)).resolves.toMatch(/^\d{45}$/);

			await pair.a.session.handleJsonMessage(24, { protocol_version: 1, epoch: 1 });
			expect(pair.a.privacy).toHaveBeenLastCalledWith(null);
			await expect(pair.a.session.getVerificationCode(USER_B)).rejects.toMatchObject({
				reason: 'participant_not_present',
			});
			expect(binaryPayloads(pair.a.binary, 26)).toHaveLength(keyPackagesBefore + 1);
			expect(pair.a.json.mock.calls.filter(call => call[0] === 23)).toHaveLength(transitionReadyBefore);
		} finally {
			await pair.close();
		}
	});

	test('requires correlation for a retained epoch greater than one', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			await expect(pair.a.session.handleJsonMessage(24, { protocol_version: 1, epoch: 2 })).rejects.toThrow(
				/match|transition ID/,
			);
		} finally {
			await pair.close();
		}
	});

	test('appends and revokes proposals, emitting opcode 28 only while a commit candidate exists', async () => {
		const external = createExternalSender();
		const a = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_A });
		const b = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_B });
		try {
			await initializePending(a, external.sender);
			await initializePending(b, external.sender);
			await a.session.handleJsonMessage(11, { user_ids: [USER_B] });
			const proposal = createAddProposal(external.identity, 0n, readLatestKeyPackage(b.binary));
			await a.session.handleBinaryMessage(27, appendProposalPayload(proposal.encoded));
			expect(a.binary).toHaveBeenCalledWith(28, expect.any(Uint8Array));

			await a.session.handleBinaryMessage(27, revokeProposalPayload(proposal.reference));
			expect(binaryPayloads(a.binary, 28)).toHaveLength(1);
		} finally {
			await Promise.all([a.close(), b.close()]);
			external.close();
		}
	});

	test('accepts the winning commit instead of treating the local candidate as authoritative', async () => {
		const external = createExternalSender();
		const a = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_A });
		const b = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_B });
		try {
			await initializePending(a, external.sender);
			await initializePending(b, external.sender);
			await a.session.handleJsonMessage(11, { user_ids: [USER_B] });
			const proposal = appendProposalPayload(
				createAddProposal(external.identity, 0n, readLatestKeyPackage(b.binary)).encoded,
			);
			await a.session.handleBinaryMessage(27, proposal);
			const aOutbound = latestBinaryPayload(a.binary, 28);

			const winningCommit = readCommitFromOutbound(aOutbound);
			await a.session.handleBinaryMessage(29, transitionPayload(70, winningCommit));
			await b.session.handleBinaryMessage(30, transitionPayload(70, readWelcomeFromOutbound(aOutbound)));

			expect(a.json).toHaveBeenCalledWith(23, { transition_id: 70 });
			expect(b.json).toHaveBeenCalledWith(23, { transition_id: 70 });
			expect(a.privacy).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{30}$/));
			expect(b.privacy).toHaveBeenLastCalledWith(a.privacy.mock.calls.at(-1)?.[0]);
			await expect(a.session.getVerificationCode(USER_B)).resolves.toMatch(/^\d{45}$/);
			await expect(b.session.getVerificationCode(USER_A)).resolves.toMatch(/^\d{45}$/);

			await a.session.handleJsonMessage(22, { transition_id: 70 });
			await b.session.handleJsonMessage(22, { transition_id: 70 });
			expect(a.session.ready).toBe(true);
			expect(b.session.ready).toBe(true);
		} finally {
			await Promise.all([a.close(), b.close()]);
			external.close();
		}
	});

	test('acknowledges a valid winning commit that removes self without reporting it invalid', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			const remove = createRemoveProposal(pair.external.identity, 1n, 0);
			const payload = appendProposalPayload(remove);
			await pair.a.session.handleBinaryMessage(27, payload);
			await pair.b.session.handleBinaryMessage(27, payload);
			expect(binaryPayloads(pair.a.binary, 28)).toHaveLength(1);
			const winningCommit = readCommitFromOutbound(latestBinaryPayload(pair.b.binary, 28));

			await pair.a.session.handleBinaryMessage(29, transitionPayload(75, winningCommit));

			expect(pair.a.json).toHaveBeenCalledWith(23, { transition_id: 75 });
			expect(pair.a.json).not.toHaveBeenCalledWith(31, expect.anything());
			expect(pair.a.session.ready).toBe(false);
			expect(pair.a.recovering).toHaveBeenCalledTimes(1);
			expect(pair.a.privacy).toHaveBeenLastCalledWith(null);
			await pair.a.session.handleJsonMessage(22, { transition_id: 75 });
			expect(pair.a.session.ready).toBe(false);
		} finally {
			await pair.close();
		}
	});

	test('keeps the old sender ratchet until execution and resets it for the new epoch', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			const frame = Uint8Array.of(1, 2, 3);
			expect(pair.a.session.transformAudioFrame(frame).at(-4)).toBe(1);
			const remove = createRemoveProposal(pair.external.identity, 1n, 1);
			await pair.a.session.handleBinaryMessage(27, appendProposalPayload(remove));
			const winningCommit = readCommitFromOutbound(latestBinaryPayload(pair.a.binary, 28));

			await pair.a.session.handleBinaryMessage(29, transitionPayload(76, winningCommit));
			expect(pair.a.session.transformAudioFrame(frame).at(-4)).toBe(2);
			await pair.a.session.handleJsonMessage(22, { transition_id: 76 });
			expect(pair.a.session.transformAudioFrame(frame).at(-4)).toBe(1);
		} finally {
			await pair.close();
		}
	});

	test('decrypts another member audio exactly once and rejects unauthenticated frames', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			const frame = Uint8Array.of(1, 2, 3, 4);
			const encrypted = pair.b.session.transformAudioFrame(frame);
			const tampered = encrypted.slice();
			tampered[0] = (tampered[0] as number) ^ 1;

			expect(pair.a.session.transformReceivedAudioFrame(USER_B, tampered)).toBeUndefined();
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, encrypted)).toEqual(frame);
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, encrypted)).toBeUndefined();
			expect(pair.a.session.transformReceivedAudioFrame('333333333333333333', encrypted)).toBeUndefined();
		} finally {
			await pair.close();
		}
	});

	test('retains a previous receive epoch for ten seconds while a commit is executed', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const pair = await establishTwoMemberGroup();
		try {
			const first = pair.b.session.transformAudioFrame(Uint8Array.of(1));
			const second = pair.b.session.transformAudioFrame(Uint8Array.of(2));
			const third = pair.b.session.transformAudioFrame(Uint8Array.of(3));
			const remove = createRemoveProposal(pair.external.identity, 1n, 1);
			await pair.a.session.handleBinaryMessage(27, appendProposalPayload(remove));
			const winningCommit = readCommitFromOutbound(latestBinaryPayload(pair.a.binary, 28));
			await pair.a.session.handleBinaryMessage(29, transitionPayload(77, winningCommit));

			expect(pair.a.session.transformReceivedAudioFrame(USER_B, first)).toEqual(Uint8Array.of(1));
			await pair.a.session.handleJsonMessage(22, { transition_id: 77 });
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, second)).toEqual(Uint8Array.of(2));
			await vi.advanceTimersByTimeAsync(10_001);
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, third)).toBeUndefined();
		} finally {
			await pair.close();
			vi.useRealTimers();
		}
	});

	test('allows plaintext only during the upgrade grace period and always accepts Opus silence', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const pair = await establishTwoMemberGroup();
		try {
			const plaintext = Uint8Array.of(1, 2, 3);
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, plaintext)).toEqual(plaintext);
			await vi.advanceTimersByTimeAsync(10_001);
			expect(pair.a.session.transformReceivedAudioFrame(USER_B, plaintext)).toBeUndefined();
			const silence = Uint8Array.of(0xf8, 0xff, 0xfe);
			const received = pair.a.session.transformReceivedAudioFrame(USER_B, silence);
			expect(received).toEqual(silence);
			expect(received).not.toBe(silence);
		} finally {
			await pair.close();
			vi.useRealTimers();
		}
	});

	test('soft-ignores an unprocessable outgoing commit candidate when no proposals are queued', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await establishSoleMember(harness, external.sender);
			await harness.session.handleBinaryMessage(29, transitionPayload(80, Uint8Array.of(0xff)));

			expect(harness.json).not.toHaveBeenCalledWith(31, expect.anything());
			expect(harness.json).not.toHaveBeenCalledWith(23, expect.anything());
			expect(harness.recovering).not.toHaveBeenCalled();
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('ignores opcode 27 without local group state only after validating its wire payload', async () => {
		const harness = createSession();
		try {
			await expect(harness.session.handleBinaryMessage(27, Uint8Array.of(0xff))).rejects.toThrow('unsupported');
			expect(harness.binary).not.toHaveBeenCalledWith(28, expect.anything());
		} finally {
			await harness.close();
		}
	});

	test('reports a processable invalid commit before sending a fresh KeyPackage and awaits recovery work', async () => {
		const external = createExternalSender();
		const a = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_A });
		const b = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_B });
		try {
			await initializePending(a, external.sender);
			await initializePending(b, external.sender);
			await a.session.handleJsonMessage(11, { user_ids: [USER_B] });
			const proposal = appendProposalPayload(
				createAddProposal(external.identity, 0n, readLatestKeyPackage(b.binary)).encoded,
			);
			await a.session.handleBinaryMessage(27, proposal);
			const before = a.binary.mock.calls.length;

			await a.session.handleBinaryMessage(29, transitionPayload(81, Uint8Array.of(0xff)));

			expect(a.session.ready).toBe(false);
			expect(a.recovering).toHaveBeenCalledTimes(1);
			expect(a.json).toHaveBeenCalledWith(31, { transition_id: 81 });
			expect(a.binary.mock.calls.slice(before).map(call => call[0])).toEqual([26]);
		} finally {
			await Promise.all([a.close(), b.close()]);
			external.close();
		}
	});

	test('resets MLS verification and ignores stale proposals while recovering an invalid next-epoch commit', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			const remove = createRemoveProposal(pair.external.identity, 1n, 1);
			await pair.a.session.handleBinaryMessage(27, appendProposalPayload(remove));

			await pair.a.session.handleBinaryMessage(29, transitionPayload(82, Uint8Array.of(0xff)));

			expect(pair.a.json).toHaveBeenCalledWith(31, { transition_id: 82 });
			expect(pair.a.privacy).toHaveBeenLastCalledWith(null);
			await expect(pair.a.session.getVerificationCode(USER_B)).rejects.toBeInstanceOf(DaveVerificationError);
			const outboundBefore = binaryPayloads(pair.a.binary, 28).length;
			await expect(pair.a.session.handleBinaryMessage(27, appendProposalPayload(remove))).resolves.toBeUndefined();
			await expect(
				pair.a.session.handleBinaryMessage(27, appendProposalPayload(Uint8Array.of(0))),
			).resolves.toBeUndefined();
			await expect(
				pair.a.session.handleBinaryMessage(27, revokeProposalPayload(new Uint8Array(31))),
			).resolves.toBeUndefined();
			expect(binaryPayloads(pair.a.binary, 28)).toHaveLength(outboundBefore);
			expect(pair.a.session.ready).toBe(false);
		} finally {
			await pair.close();
		}
	});

	test('rejoins through a combined remove and add after resetting an invalid Welcome', async () => {
		const pair = await establishTwoMemberGroup();
		try {
			await pair.a.session.handleBinaryMessage(30, transitionPayload(82, Uint8Array.of(0xff)));
			expect(pair.a.json).toHaveBeenCalledWith(31, { transition_id: 82 });

			const removeOldA = createRemoveProposal(pair.external.identity, 1n, 0);
			const addFreshA = createAddProposal(pair.external.identity, 1n, readLatestKeyPackage(pair.a.binary)).encoded;
			const replacement = appendProposalPayload(concatenateBytes(removeOldA, addFreshA));
			const commitsBefore = binaryPayloads(pair.a.binary, 28).length;
			await pair.a.session.handleBinaryMessage(27, replacement);
			expect(binaryPayloads(pair.a.binary, 28)).toHaveLength(commitsBefore);

			await pair.b.session.handleBinaryMessage(27, replacement);
			const outbound = latestBinaryPayload(pair.b.binary, 28);
			await pair.b.session.handleBinaryMessage(29, transitionPayload(83, readCommitFromOutbound(outbound)));
			await pair.a.session.handleBinaryMessage(30, transitionPayload(83, readWelcomeFromOutbound(outbound)));
			await pair.b.session.handleJsonMessage(22, { transition_id: 83 });
			await pair.a.session.handleJsonMessage(22, { transition_id: 83 });

			expect(pair.a.session.ready).toBe(true);
			expect(pair.a.privacy).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{30}$/));
			await expect(pair.a.session.getVerificationCode(USER_B)).resolves.toMatch(/^\d{45}$/);
		} finally {
			await pair.close();
		}
	});

	test('rejects malformed transition prefixes without inventing transition zero or starting recovery', async () => {
		const external = createExternalSender();
		const harness = createSession();
		try {
			await establishSoleMember(harness, external.sender);
			await expect(harness.session.handleBinaryMessage(30, Uint8Array.of(1))).rejects.toThrow(/truncated|MLS/i);

			expect(harness.json).not.toHaveBeenCalledWith(31, { transition_id: 0 });
			expect(harness.recovering).not.toHaveBeenCalled();
		} finally {
			await harness.close();
			external.close();
		}
	});

	test('rejects unknown transitions and conflicting external senders', async () => {
		const external = createExternalSender();
		const other = createExternalSender();
		const harness = createSession();
		try {
			await expect(harness.session.handleJsonMessage(22, { transition_id: 10 })).rejects.toThrow('unknown');
			await harness.session.handleBinaryMessage(25, encodeExternalSender(external.sender));
			await expect(harness.session.handleBinaryMessage(25, encodeExternalSender(other.sender))).rejects.toThrow(
				/conflicting/i,
			);
		} finally {
			await harness.close();
			external.close();
			other.close();
		}
	});

	test('shares one identity across live sessions and replaces it after the last closes', async () => {
		const factory = createDaveSessionFactory();
		const first = createSession(factory);
		const second = createSession(factory, { channelId: CHANNEL_ID, userId: USER_B });
		await first.session.setProtocolVersion(1);
		await second.session.setProtocolVersion(1);
		const firstKey = readLatestKeyPackage(first.binary).leafNode.signatureKey;
		const secondKey = readLatestKeyPackage(second.binary).leafNode.signatureKey;
		expect(secondKey).toEqual(firstKey);

		await first.close(false);
		await second.close(false);
		const third = createSession(factory, { channelId: '999999999999999999', userId: USER_B });
		await third.session.setProtocolVersion(1);
		expect(readLatestKeyPackage(third.binary).leafNode.signatureKey).not.toEqual(firstKey);
		await third.close(false);
		await factory.close();
	});

	test('retains one identity across a sequential transport replacement', async () => {
		const factory = createDaveSessionFactory();
		const first = createSession(factory);
		await first.session.setProtocolVersion(1);
		const firstKey = readLatestKeyPackage(first.binary).leafNode.signatureKey;
		const releaseReplacement = factory.retain();

		await first.close(false);
		const replacement = createSession(factory, { channelId: CHANNEL_ID, userId: USER_B });
		await replacement.session.setProtocolVersion(1);
		expect(readLatestKeyPackage(replacement.binary).leafNode.signatureKey).toEqual(firstKey);
		releaseReplacement();

		await replacement.close(false);
		const later = createSession(factory, { channelId: CHANNEL_ID, userId: USER_A });
		await later.session.setProtocolVersion(1);
		expect(readLatestKeyPackage(later.binary).leafNode.signatureKey).not.toEqual(firstKey);
		await later.close(false);
		await factory.close();
	});

	test('releases group and identity resources when a close callback throws', async () => {
		const factory = createDaveSessionFactory();
		const first = createSession(factory);
		await first.session.setProtocolVersion(1);
		const firstKey = readLatestKeyPackage(first.binary).leafNode.signatureKey;
		first.privacy.mockImplementation(() => {
			throw new Error('privacy callback failed');
		});

		await expect(first.session.close()).rejects.toThrow('privacy callback failed');
		const second = createSession(factory, { channelId: CHANNEL_ID, userId: USER_B });
		await second.session.setProtocolVersion(1);
		expect(readLatestKeyPackage(second.binary).leafNode.signatureKey).not.toEqual(firstKey);
		await second.close(false);
		await factory.close();
	});
});

function createSession(
	factory: DaveSessionFactoryResource = createDaveSessionFactory(),
	input: DaveSessionInput = { channelId: CHANNEL_ID, userId: USER_A },
) {
	const json = vi.fn();
	const binary = vi.fn();
	const ready = vi.fn();
	const recovering = vi.fn();
	const privacy = vi.fn();
	const session = factory(input, {
		sendJson: json,
		sendBinary: binary,
		onReady: ready,
		onRecovering: recovering,
		onVoicePrivacyCodeChange: privacy,
	});
	return {
		session,
		json,
		binary,
		ready,
		recovering,
		privacy,
		async close(closeFactory = true) {
			await session.close();
			if (closeFactory) await factory.close();
		},
	};
}

async function initializePending(harness: SessionHarness, sender: MlsExternalSender): Promise<void> {
	await harness.session.handleBinaryMessage(25, encodeExternalSender(sender));
	await harness.session.setProtocolVersion(1);
}

async function establishSoleMember(harness: SessionHarness, sender: MlsExternalSender): Promise<void> {
	await initializePending(harness, sender);
	await harness.session.handleJsonMessage(21, { protocol_version: 1, transition_id: 0 });
}

async function establishTwoMemberGroup() {
	const external = createExternalSender();
	const a = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_A });
	const b = createSession(undefined, { channelId: CHANNEL_ID, userId: USER_B });
	await initializePending(a, external.sender);
	await initializePending(b, external.sender);
	await a.session.handleJsonMessage(11, { user_ids: [USER_B] });
	await b.session.handleJsonMessage(11, { user_ids: [USER_A] });
	const proposal = appendProposalPayload(
		createAddProposal(external.identity, 0n, readLatestKeyPackage(b.binary)).encoded,
	);
	await a.session.handleBinaryMessage(27, proposal);
	const outbound = latestBinaryPayload(a.binary, 28);
	const transitionId = 50;
	await a.session.handleBinaryMessage(29, transitionPayload(transitionId, readCommitFromOutbound(outbound)));
	await b.session.handleBinaryMessage(30, transitionPayload(transitionId, readWelcomeFromOutbound(outbound)));
	await a.session.handleJsonMessage(22, { transition_id: transitionId });
	await b.session.handleJsonMessage(22, { transition_id: transitionId });
	return {
		a,
		b,
		external,
		async close() {
			await Promise.all([a.close(), b.close()]);
			external.close();
		},
	};
}

function createExternalSender() {
	const identity = new DaveIdentity(provider);
	return {
		identity,
		sender: {
			signatureKey: identity.publicKey,
			credential: { type: CredentialType.Basic, identity: Uint8Array.of(1) },
		} satisfies MlsExternalSender,
		close: () => identity.close(),
	};
}

function createAddProposal(identity: DaveIdentity, epoch: bigint, keyPackage: MlsKeyPackage) {
	const message = {
		version: ProtocolVersion.Mls10,
		wireFormat: WireFormat.PublicMessage,
		publicMessage: createExternalProposalPublicMessage(identity, {
			groupId: encodeSnowflakeBigEndian(CHANNEL_ID),
			epoch,
			senderIndex: 0,
			proposal: { type: ProposalType.Add, keyPackage },
		}),
	} as const;
	const encoded = encodeMlsMessage(message);
	const reference = proposalReference(provider, {
		wireFormat: WireFormat.PublicMessage,
		content: message.publicMessage.content,
		auth: message.publicMessage.auth,
	});
	return { encoded, reference };
}

function createRemoveProposal(identity: DaveIdentity, epoch: bigint, removed: number): Uint8Array {
	return encodeMlsMessage({
		version: ProtocolVersion.Mls10,
		wireFormat: WireFormat.PublicMessage,
		publicMessage: createExternalProposalPublicMessage(identity, {
			groupId: encodeSnowflakeBigEndian(CHANNEL_ID),
			epoch,
			senderIndex: 0,
			proposal: { type: ProposalType.Remove, removed },
		}),
	});
}

function encodeExternalSender(sender: MlsExternalSender): Uint8Array {
	return new MlsWriter()
		.vector(sender.signatureKey)
		.uint16(sender.credential.type)
		.vector(sender.credential.identity)
		.finish();
}

function appendProposalPayload(encoded: Uint8Array): Uint8Array {
	return new MlsWriter().uint8(DaveMlsProposalOperation.Append).vector(encoded).finish();
}

function revokeProposalPayload(reference: Uint8Array): Uint8Array {
	return new MlsWriter()
		.uint8(DaveMlsProposalOperation.Revoke)
		.vectorWith(writer => writer.vector(reference))
		.finish();
}

function transitionPayload(transitionId: number, encodedMessage: Uint8Array): Uint8Array {
	return new MlsWriter().uint16(transitionId).bytes(encodedMessage).finish();
}

function readLatestKeyPackage(binary: ReturnType<typeof vi.fn>): MlsKeyPackage {
	return readKeyPackage(latestBinaryPayload(binary, 26));
}

function readKeyPackage(encodedMessage: Uint8Array): MlsKeyPackage {
	return decodeKeyPackage(encodedMessage);
}

function readCommitFromOutbound(outbound: Uint8Array): Uint8Array {
	for (let length = 1; length <= outbound.byteLength; length++) {
		try {
			const commit = outbound.subarray(0, length);
			const message = decodeMlsMessage(commit);
			if (message.wireFormat !== WireFormat.PublicMessage) continue;
			return commit;
		} catch {}
	}
	throw new Error('Expected an MLS commit PublicMessage.');
}

function readWelcomeFromOutbound(outbound: Uint8Array): Uint8Array {
	const commit = readCommitFromOutbound(outbound);
	const welcome = outbound.subarray(commit.byteLength);
	decodeWelcome(welcome);
	return welcome;
}

function latestBinaryPayload(binary: ReturnType<typeof vi.fn>, opcode: number): Uint8Array {
	const payload = binary.mock.calls.filter(call => call[0] === opcode).at(-1)?.[1];
	if (!(payload instanceof Uint8Array)) throw new Error(`Expected binary opcode ${opcode}.`);
	return payload;
}

function binaryPayloads(binary: ReturnType<typeof vi.fn>, opcode: number): Uint8Array[] {
	return binary.mock.calls.filter(call => call[0] === opcode).map(call => call[1] as Uint8Array);
}

type SessionHarness = ReturnType<typeof createSession>;
