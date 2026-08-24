import { describe, expect, test } from 'vitest';
import { concatenateBytes } from '../src/bytes';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { encodeSnowflakeBigEndian } from '../src/dave/verification';
import { DaveMlsGroup } from '../src/mls/group';
import { createExternalProposalPublicMessage, proposalReference } from '../src/mls/handshake';
import {
	CredentialType,
	decodeKeyPackage,
	decodeMlsMessage,
	decodeMlsMessages,
	decodeWelcome,
	encodeMlsMessage,
	encodeMlsMessages,
	type MlsExternalSender,
	type MlsKeyPackage,
	type MlsProposal,
	ProposalType,
	ProtocolVersion,
	WireFormat,
} from '../src/mls/protocol';

const provider = new VoiceCryptoProvider();
const GROUP_ID = encodeSnowflakeBigEndian('555555555555555555');
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const USER_C = '333333333333333333';

describe('DAVE MLS group orchestration', () => {
	test('converges a creator and two joiners through Commit and raw Welcome, then processes a removal path', () => {
		const external = createExternalSender();
		const a = createGroup(USER_A, external.sender);
		const b = createGroup(USER_B, external.sender);
		const c = createGroup(USER_C, external.sender);
		try {
			const bKeyPackage = readKeyPackage(b.group.createKeyPackage());
			const cKeyPackage = readKeyPackage(c.group.createKeyPackage());
			const addPayload = encodeExternalProposals(external.identity, 0n, [
				{ type: ProposalType.Add, keyPackage: bKeyPackage },
				{ type: ProposalType.Add, keyPackage: cKeyPackage },
			]);
			const expectedUsers = new Set([USER_A, USER_B, USER_C]);

			const outbound = a.group.appendProposals(addPayload, expectedUsers);
			if (outbound === undefined) throw new Error('Expected an outbound add commit.');
			expect(a.group.established).toBe(false);
			expect(a.group.hasPendingGroup).toBe(true);
			expect(outbound.encodedWelcome).toBeDefined();
			expect(() => decodeWelcome(outbound.encodedWelcome as Uint8Array)).not.toThrow();
			expect(outbound.payload).toEqual(concatenateBytes(outbound.encodedCommit, outbound.encodedWelcome as Uint8Array));

			a.group.acceptCommit(outbound.encodedCommit);
			b.group.processWelcome(outbound.encodedWelcome as Uint8Array);
			c.group.processWelcome(outbound.encodedWelcome as Uint8Array);

			assertConverged([a.group, b.group, c.group], 1n, [USER_A, USER_B, USER_C]);

			const removedLeafIndex = a.group.roster.get(USER_C)?.leafIndex;
			if (removedLeafIndex === undefined) throw new Error('Expected the third member in the DAVE roster.');
			const removePayload = encodeExternalProposals(external.identity, 1n, [
				{ type: ProposalType.Remove, removed: removedLeafIndex },
			]);
			const aRemoval = a.group.appendProposals(removePayload, expectedUsers);
			const bRemoval = b.group.appendProposals(removePayload, expectedUsers);
			if (aRemoval === undefined || bRemoval === undefined) throw new Error('Expected outbound removal commits.');
			expect(aRemoval.encodedWelcome).toBeUndefined();
			expect(bRemoval.encodedWelcome).toBeUndefined();
			expect(aRemoval.encodedCommit).not.toEqual(bRemoval.encodedCommit);

			a.group.acceptCommit(aRemoval.encodedCommit);
			b.group.acceptCommit(aRemoval.encodedCommit);

			assertConverged([a.group, b.group], 2n, [USER_A, USER_B]);
			expect(a.group.roster.has(USER_C)).toBe(false);
			expect(() => a.group.getVerificationKey(USER_C)).toThrow('unavailable');
			expect(a.group.exportSecret('test', Uint8Array.of(1, 2, 3), 32)).toEqual(
				b.group.exportSecret('test', Uint8Array.of(1, 2, 3), 32),
			);
		} finally {
			a.close();
			b.close();
			c.close();
			external.close();
		}
	});

	test('welcomes a replacement member with a path secret in a remove-and-add commit', () => {
		const external = createExternalSender();
		const a = createGroup(USER_A, external.sender);
		const b = createGroup(USER_B, external.sender);
		const c = createGroup(USER_C, external.sender);
		try {
			const bKeyPackage = readKeyPackage(b.group.createKeyPackage());
			const initialUsers = new Set([USER_A, USER_B]);
			const initial = a.group.appendProposals(
				encodeExternalProposals(external.identity, 0n, [{ type: ProposalType.Add, keyPackage: bKeyPackage }]),
				initialUsers,
			);
			if (initial === undefined || initial.encodedWelcome === undefined) {
				throw new Error('Expected an initial outbound Welcome.');
			}
			a.group.acceptCommit(initial.encodedCommit);
			b.group.processWelcome(initial.encodedWelcome);

			const bLeafIndex = a.group.roster.get(USER_B)?.leafIndex;
			if (bLeafIndex === undefined) throw new Error('Expected the replaced member in the DAVE roster.');
			const cKeyPackage = readKeyPackage(c.group.createKeyPackage());
			const replacement = encodeExternalProposals(external.identity, 1n, [
				{ type: ProposalType.Remove, removed: bLeafIndex },
				{ type: ProposalType.Add, keyPackage: cKeyPackage },
			]);
			const replacementUsers = new Set([USER_A, USER_B, USER_C]);
			const winning = a.group.appendProposals(replacement, replacementUsers);
			expect(b.group.appendProposals(replacement, replacementUsers)).toBeUndefined();
			if (winning === undefined || winning.encodedWelcome === undefined) {
				throw new Error('Expected a replacement Welcome with path material.');
			}

			expect(a.group.acceptCommit(winning.encodedCommit)).toBe('accepted');
			expect(b.group.acceptCommit(winning.encodedCommit)).toBe('removed');
			c.group.processWelcome(winning.encodedWelcome);

			assertConverged([a.group, c.group], 2n, [USER_A, USER_C]);
		} finally {
			a.close();
			b.close();
			c.close();
			external.close();
		}
	});

	test('accepts a valid winning commit that removes the local member and clears its state', () => {
		const external = createExternalSender();
		const a = createGroup(USER_A, external.sender);
		const b = createGroup(USER_B, external.sender);
		try {
			const bKeyPackage = readKeyPackage(b.group.createKeyPackage());
			const add = encodeExternalProposals(external.identity, 0n, [{ type: ProposalType.Add, keyPackage: bKeyPackage }]);
			const expectedUsers = new Set([USER_A, USER_B]);
			const added = a.group.appendProposals(add, expectedUsers);
			if (added === undefined) throw new Error('Expected an outbound add commit.');
			a.group.acceptCommit(added.encodedCommit);
			b.group.processWelcome(added.encodedWelcome as Uint8Array);

			const aLeafIndex = b.group.roster.get(USER_A)?.leafIndex;
			if (aLeafIndex === undefined) throw new Error('Expected the creator in the DAVE roster.');
			const remove = encodeExternalProposals(external.identity, 1n, [
				{ type: ProposalType.Remove, removed: aLeafIndex },
			]);
			expect(a.group.appendProposals(remove, expectedUsers)).toBeUndefined();
			const winning = b.group.appendProposals(remove, expectedUsers);
			if (winning === undefined) throw new Error('Expected an outbound removal commit.');

			expect(a.group.acceptCommit(winning.encodedCommit)).toBe('removed');
			expect(a.group.established).toBe(false);
			expect(a.group.epoch).toBeUndefined();
			expect(() => a.group.epochAuthenticator).toThrow('not established');
		} finally {
			a.close();
			b.close();
			external.close();
		}
	});

	test('rejects a winning commit that omits any queued unrevoked ProposalRef', () => {
		const external = createExternalSender();
		const a = createGroup(USER_A, external.sender);
		const b = createGroup(USER_B, external.sender);
		const c = createGroup(USER_C, external.sender);
		try {
			const bKeyPackage = readKeyPackage(b.group.createKeyPackage());
			const cKeyPackage = readKeyPackage(c.group.createKeyPackage());
			const firstProposal = encodeExternalProposals(external.identity, 0n, [
				{ type: ProposalType.Add, keyPackage: bKeyPackage },
			]);
			const secondProposal = encodeExternalProposals(external.identity, 0n, [
				{ type: ProposalType.Add, keyPackage: cKeyPackage },
			]);
			const expectedUsers = new Set([USER_A, USER_B, USER_C]);
			const incomplete = a.group.appendProposals(firstProposal, expectedUsers);
			if (incomplete === undefined) throw new Error('Expected an outbound add commit.');
			a.group.appendProposals(secondProposal, expectedUsers);

			expect(() => a.group.acceptCommit(incomplete.encodedCommit)).toThrow('every queued unrevoked proposal');
			expect(a.group.established).toBe(false);
		} finally {
			a.close();
			b.close();
			c.close();
			external.close();
		}
	});

	test('promotes epoch zero only through the explicit pending activation path', () => {
		const external = createExternalSender();
		const member = createGroup(USER_A, external.sender);
		try {
			expect(member.group.established).toBe(false);
			member.group.activatePending();
			expect(member.group.established).toBe(true);
			expect(member.group.epoch).toBe(0n);
			expect([...member.group.roster]).toHaveLength(1);
			expect(() => member.group.activatePending()).toThrow('already established');
			expect(() => member.group.createKeyPackage()).toThrow('unavailable');
		} finally {
			member.close();
			external.close();
		}
	});

	test('revocation invalidates the prepared outbound state before it can win', () => {
		const external = createExternalSender();
		const creator = createGroup(USER_A, external.sender);
		const joiner = createGroup(USER_B, external.sender);
		try {
			const keyPackage = readKeyPackage(joiner.group.createKeyPackage());
			const proposals = encodeExternalProposals(external.identity, 0n, [{ type: ProposalType.Add, keyPackage }]);
			const outbound = creator.group.appendProposals(proposals, new Set([USER_A, USER_B]));
			if (outbound === undefined) throw new Error('Expected an outbound add commit.');
			const proposalMessage = decodeMlsMessages(proposals)[0];
			if (proposalMessage?.wireFormat !== WireFormat.PublicMessage) throw new Error('Expected a proposal message.');
			const reference = proposalReference(provider, {
				wireFormat: WireFormat.PublicMessage,
				content: proposalMessage.publicMessage.content,
				auth: proposalMessage.publicMessage.auth,
			});

			expect(creator.group.revokeProposals([reference])).toBeUndefined();
			expect(creator.group.acceptCommit(outbound.encodedCommit)).toBe('ignored');
			expect(creator.group.established).toBe(false);
		} finally {
			creator.close();
			joiner.close();
			external.close();
		}
	});

	test('soft-ignores a commit when no proposals are queued or it targets another group', () => {
		const external = createExternalSender();
		const creator = createGroup(USER_A, external.sender);
		const joiner = createGroup(USER_B, external.sender);
		try {
			expect(creator.group.acceptCommit(Uint8Array.of(0xff))).toBe('ignored');
			const keyPackage = readKeyPackage(joiner.group.createKeyPackage());
			const outbound = creator.group.appendProposals(
				encodeExternalProposals(external.identity, 0n, [{ type: ProposalType.Add, keyPackage }]),
				new Set([USER_A, USER_B]),
			);
			if (outbound === undefined) throw new Error('Expected an outbound add commit.');
			const message = decodeMlsMessage(outbound.encodedCommit);
			if (message.wireFormat !== WireFormat.PublicMessage) throw new Error('Expected a Commit message.');
			const otherGroupCommit = encodeMlsMessage({
				...message,
				publicMessage: {
					...message.publicMessage,
					content: { ...message.publicMessage.content, groupId: Uint8Array.of(1) },
				},
			});

			expect(creator.group.acceptCommit(otherGroupCommit)).toBe('ignored');
			expect(creator.group.established).toBe(false);
		} finally {
			creator.close();
			joiner.close();
			external.close();
		}
	});
});

function createGroup(userId: string, externalSender: MlsExternalSender): GroupResource {
	const identity = new DaveIdentity(provider);
	const group = new DaveMlsGroup(provider, identity, { groupId: GROUP_ID, userId });
	group.installExternalSender(externalSender);
	return {
		group,
		close: () => {
			group.close();
			identity.close();
		},
	};
}

function createExternalSender(): ExternalSenderResource {
	const identity = new DaveIdentity(provider);
	return {
		identity,
		sender: {
			signatureKey: identity.publicKey,
			credential: { type: CredentialType.Basic, identity: Uint8Array.of(1) },
		},
		close: () => identity.close(),
	};
}

function readKeyPackage(encodedMessage: Uint8Array): MlsKeyPackage {
	return decodeKeyPackage(encodedMessage);
}

function encodeExternalProposals(identity: DaveIdentity, epoch: bigint, proposals: readonly MlsProposal[]): Uint8Array {
	return encodeMlsMessages(
		proposals.map(proposal => ({
			version: ProtocolVersion.Mls10,
			wireFormat: WireFormat.PublicMessage,
			publicMessage: createExternalProposalPublicMessage(identity, {
				groupId: GROUP_ID,
				epoch,
				senderIndex: 0,
				proposal,
			}),
		})),
	);
}

function assertConverged(groups: readonly DaveMlsGroup[], epoch: bigint, expectedUsers: readonly string[]): void {
	const first = groups[0];
	if (first === undefined) throw new Error('Expected at least one DAVE group.');
	const authenticator = first.epochAuthenticator;
	for (const group of groups) {
		expect(group.established).toBe(true);
		expect(group.epoch).toBe(epoch);
		expect(group.epochAuthenticator).toEqual(authenticator);
		expect([...group.roster.keys()].sort()).toEqual([...expectedUsers].sort());
	}
}

interface GroupResource {
	readonly group: DaveMlsGroup;
	close(): void;
}

interface ExternalSenderResource {
	readonly identity: DaveIdentity;
	readonly sender: MlsExternalSender;
	close(): void;
}
