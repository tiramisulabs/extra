import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import { DaveIdentity } from '../src/dave/identity';
import { encodeSnowflakeBigEndian } from '../src/dave/verification';
import { createDaveLeafMaterial } from '../src/mls/profile';
import {
	CredentialType,
	encodeLeafNodeTbs,
	type MlsExternalSender,
	type MlsLeafNode,
	NodeType,
} from '../src/mls/protocol';
import {
	assertDaveGroupContext,
	createInitialDaveMlsGroupState,
	readDaveExternalSender,
	readDaveMlsRoster,
} from '../src/mls/state';

const provider = new VoiceCryptoProvider();

describe('DAVE MLS group state', () => {
	test('creates the RFC 9420 epoch-zero group with the DAVE external sender', () => {
		const identity = new DaveIdentity(provider);
		const leaf = createDaveLeafMaterial(provider, identity, '123');
		const sender = createExternalSender();
		const groupId = encodeSnowflakeBigEndian('456');

		const state = createInitialDaveMlsGroupState(provider, leaf, groupId, sender);

		expect(state.context).toMatchObject({ epoch: 0n, groupId });
		expect(state.context.confirmedTranscriptHash).toHaveLength(0);
		expect(state.interimTranscriptHash).toHaveLength(32);
		expect(state.confirmationTag).toHaveLength(32);
		expect(state.secrets.epochAuthenticator).toHaveLength(32);
		expect(state.roster.get('123')).toMatchObject({ leafIndex: 0, userId: '123' });
		expect(readDaveExternalSender(provider, state.context)).toEqual(sender);
		expect(state.getPrivateKey(0)).toHaveLength(32);

		leaf.close();
		expect(state.getPrivateKey(0)).toHaveLength(32);
		state.close();
		expect(() => state.getPrivateKey(0)).toThrow('closed');
		identity.close();
	});

	test('rejects a context whose external sender or tree hash is not canonical', () => {
		const identity = new DaveIdentity(provider);
		const leaf = createDaveLeafMaterial(provider, identity, '123');
		const sender = createExternalSender();
		const state = createInitialDaveMlsGroupState(provider, leaf, encodeSnowflakeBigEndian('456'), sender);

		const wrongSender = createExternalSender();
		expect(() => assertDaveGroupContext(provider, state.context, state.tree, wrongSender)).toThrow('external sender');
		expect(() =>
			assertDaveGroupContext(provider, { ...state.context, treeHash: new Uint8Array(32) }, state.tree, sender),
		).toThrow('tree hash');

		state.close();
		leaf.close();
		identity.close();
	});

	test('exposes defensive private-key copies', () => {
		const identity = new DaveIdentity(provider);
		const leaf = createDaveLeafMaterial(provider, identity, '123');
		const state = createInitialDaveMlsGroupState(
			provider,
			leaf,
			encodeSnowflakeBigEndian('456'),
			createExternalSender(),
		);

		const first = state.getPrivateKey(0);
		if (first === undefined) throw new Error('The initial group must retain its leaf key.');
		first.fill(0);
		expect(state.getPrivateKey(0)).not.toEqual(first);

		state.close();
		leaf.close();
		identity.close();
	});

	test('rejects reuse between signature and encryption keys across the ratchet tree', () => {
		const firstIdentity = new DaveIdentity(provider);
		const secondIdentity = new DaveIdentity(provider);
		const firstLeaf = createDaveLeafMaterial(provider, firstIdentity, '123');
		const secondLeaf = createDaveLeafMaterial(provider, secondIdentity, '124');
		const unsigned: MlsLeafNode = {
			...secondLeaf.leafNode,
			encryptionKey: firstLeaf.leafNode.signatureKey,
			signature: new Uint8Array(),
		};
		const reusedLeaf: MlsLeafNode = {
			...unsigned,
			signature: secondIdentity.sign('LeafNodeTBS', encodeLeafNodeTbs(unsigned)),
		};

		try {
			expect(() =>
				readDaveMlsRoster(
					provider,
					Object.freeze([
						Object.freeze({ type: NodeType.Leaf, leafNode: firstLeaf.leafNode }),
						undefined,
						Object.freeze({ type: NodeType.Leaf, leafNode: reusedLeaf }),
					]),
					encodeSnowflakeBigEndian('456'),
				),
			).toThrow('duplicate ratchet tree key');
		} finally {
			firstLeaf.close();
			secondLeaf.close();
			firstIdentity.close();
			secondIdentity.close();
		}
	});
});

function createExternalSender(): MlsExternalSender {
	return {
		signatureKey: provider.generateP256KeyPair().publicKey,
		credential: { type: CredentialType.Basic, identity: Uint8Array.of(0x44) },
	};
}
