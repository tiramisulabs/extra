import { describe, expect, test } from 'vitest';
import { VoiceCryptoProvider } from '../src/crypto/provider';
import {
	CredentialType,
	decodeRatchetTree,
	LeafNodeSource,
	type MlsLeafNode,
	type MlsNode,
	type MlsParentNode,
	NodeType,
} from '../src/mls/protocol';
import {
	addLeaf,
	assertRatchetTree,
	computeParentHash,
	copath,
	directPath,
	filteredDirectPath,
	leafNodeIndex,
	leftChild,
	MAX_MLS_TREE_LEAVES,
	MAX_MLS_TREE_NODES,
	type MlsRatchetTree,
	nodeLevel,
	nodeWidth,
	parentNode,
	removeLeaf,
	resolution,
	rightChild,
	siblingNode,
	treeHash,
	treeRoot,
	validateParentHash,
	validateParentHashes,
} from '../src/mls/tree';

const provider = new VoiceCryptoProvider();

const OFFICIAL_TREE_MATH_VECTORS = [
	{
		leafCount: 1,
		nodeCount: 1,
		root: 0,
		left: [null],
		right: [null],
		parent: [null],
		sibling: [null],
	},
	{
		leafCount: 2,
		nodeCount: 3,
		root: 1,
		left: [null, 0, null],
		right: [null, 2, null],
		parent: [1, null, 1],
		sibling: [2, null, 0],
	},
	{
		leafCount: 4,
		nodeCount: 7,
		root: 3,
		left: [null, 0, null, 1, null, 4, null],
		right: [null, 2, null, 5, null, 6, null],
		parent: [1, 3, 1, null, 5, 3, 5],
		sibling: [2, 5, 0, null, 6, 1, 4],
	},
	{
		leafCount: 8,
		nodeCount: 15,
		root: 7,
		left: [null, 0, null, 1, null, 4, null, 3, null, 8, null, 9, null, 12, null],
		right: [null, 2, null, 5, null, 6, null, 11, null, 10, null, 13, null, 14, null],
		parent: [1, 3, 1, 7, 5, 3, 5, null, 9, 11, 9, 7, 13, 11, 13],
		sibling: [2, 5, 0, 11, 6, 1, 4, null, 10, 13, 8, 3, 14, 9, 12],
	},
] as const;

const OFFICIAL_SUITE_2_TREE = {
	encoded:
		'425e010140410465bb3ad2d28cbd32bbe9b4f503d8e8b219817c76176e1e4ebad984a313486d153c0aad7e2b446aefc6135bc7cb18fd24d532b895d25db98442d9e279472d5f7840410445a659ecf2c9c7b4d5ca734bdd715539eb3370173db9bba4fbb8fcba2dc801d853068383332714287aebdb3414409f23d5769b8d99b4ec25761d94cf0e34f17f000105416c6963650200010e000100020003000400050006000700000200010320bceac4bbc8c8c207f8003c8b59294e9633c8bbc16e8bbb79224089d664625c630040473045022100d8b9d9d00f99f3c6fa38951ce435d07a8cf25bd314e5787e03c4379a9a08a79b022028ef5d1d7e89aed1bb3f9b2a4606b515e64c73436c619b71a75e257805d7f00601024041047922eaba93824d14006efeefcae2387e3b5eb1431af3acee2cff56ece3dc8f8b83d6d2177c7d9bacdc9197028ebabee32bd09a65cb477806665aed89a5e6273d0000010140410423ede1154d546c83923ef74752848abd9b503be08d385a38730ad1ad491d86ee8caf9f271241766b1bfcea6e6ffb711c6423038f75994de2c16a9ebe1046fa364041041547dbeabd573582223ea028ddeeac650db35440c81b29dce939de4d78559cc1a9d2c43a188ea169d09e4263fbe5665edf28798baa332b189f33a2ff9e3fbdfd000106416c696365310200010e00010002000300040005000600070000020001010000000063f31e410000000065d45fd10040483046022100e654b0c2c72f1b1b518f0289339dfc5b9dace1ff03d1e8acd0575a83d7f4b1ea022100bc1e370cbbf2ee49183438f71b76026e1e0c2aab5f7e6b89c98f306468df7237',
	resolutions: [[0], [1], [2]],
	treeHashes: [
		'56b82ef0deb84f9ea6dc69a81f010138676000f202f343e8b9d0bdfebc072d34',
		'445684e05c47db32d363a9eeee5541d9156b15bfd826de54c03c006aab828d85',
		'3e27047e332469592a914e8c6a5702682b954b1dd3872b83f6b22540f29a91c3',
	],
} as const;

const OFFICIAL_SUITE_2_COMPACT_TREE = {
	encoded:
		'43d801014041043dcf9c6dfabf637eae5d1ac11d170c0cd1b1ef4f963307b9a46a17064d7117ed57a26065498c5677b274a069ecd77c0e3ff033b6ca05c2cde7323ce47b4e12c54041048092a302bd85b6478ac38c3592763e0c574a0e3223254559dcaa2c391d8a521787b70ab8177b0ea03ccfd44c689adb715819080b4e98974545c47b889b34ee84000105416c6963650200010e000100020003000400050006000700000200010320ce68e169fabb3484632408a1b83ceebe9f55ec934ca78afeba76a7bfdfb562c00040473045022100f7d4143b81295e354226f8e4535f921e6e1a73f47334ba3f1c2dcd45a6831620022041b5936ac8b171829d7737587e2f21922733048d97f9fb83564dd727dc0a980a01024041043442479d6422492e6c5310cfb7d8974a359004b2e1b2396c0874cffded66b34cc92f9ff54ff59e68d5f78c9346ee4deb9b3bd0be69a85171d12bafb48213545d2049e93b21c661b9799a25c39962c716d20c9e74ae6f0aa83ba16e039829559e5b000101404104b63973d3d9f53d2c98955ddf3a9d89d26c15998bdbcc5a27be7b344fd00ee4fb7f0793694431863f0653e448944bba07e4d3b154a9383a09f768efaafb2e99724041045ed2adade28695b578e7dc5f2461136d45c3a84968f23230e3daf2ce8707a87afc74ea32679842f8c967b7bfabf2021bdfea885b1fcab42629e5ca3ad35da367000106416c696365310200010e0001000200030004000500060007000002000103201d8090b8ceb780693a3f2af53cc65032398e0cb8d414bd8b74e1261f7500b50a00404730450220275786a798cd573572d166e0f83b5ed6e5af7d838b0ee78cd554c8ebc45c12ae022100a265f51540c43196e6b7bf249ef3c943aec6544cabb90860461e5479edd7ed850102404104f195995dfbe4b1963d41e54e8c6343ea7cf99862f517431d33b6ebdf4490b5fb608fcaadb944d2be16f285470d170749a905eb7f267861abd9b5c490a4090a230000010140410469308a06a05492b2a4024a592477a502fbef2da7e3defdb78a79505c0369801bb5e700f51f5a02d96d3aa1a6ae3324eaca988332c2102d3106029db47d6975bc404104293b221341d7277d37853509606b501ea21e4289db0782b39a63ddd440d077a37eb62602c648fea134bfde144844795b9c84c353cba4450033555a407cc653c8000106416c696365320200010e00010002000300040005000600070000020001010000000063f31e410000000065d45fd10040473045022047e0f35fc5765f971350d8eb46a44a6eaa25e2bc56677e3415769330be4cea49022100e71f6c0c9b7f1cd1307155018db27431ddce72fd229dce8dd6b3983fef4416c2',
	resolutions: [[0], [1], [2], [3], [4], [4], []],
	treeHashes: [
		'2b0366f25b2bfddd5f2318f802e843c4fe6f94b9d4cd41c2d0b5be105001c806',
		'dd290d5d4cef8889c4db85522b3fcd61e1ec72e906394970dffa00159499d251',
		'eb5fdea37ddb706b9cda8d6d1af1234ef7dc766e75d20d3f788ca4aeec7afe06',
		'e0c642540aef26ec8e6def11733dc11e3b2271a77a7eeccab40bc58e6ce7b997',
		'75240bcb0d0520e8d10a753501ac38e6c8c8a9d9f8919af8b222db726f01c5f4',
		'cf5769eb0407543d95a07f6d6092a930821f1f7057289d26b63880b9167e1049',
		'caf009ad02a57a48feb8d64d055509e9a81edba8d325e442cfe75e006a520006',
	],
} as const;

describe('MLS array tree math', () => {
	test('matches the official RFC 9420 tree-math vectors', () => {
		for (const vector of OFFICIAL_TREE_MATH_VECTORS) {
			expect(nodeWidth(vector.leafCount)).toBe(vector.nodeCount);
			expect(treeRoot(vector.leafCount)).toBe(vector.root);
			for (let index = 0; index < vector.nodeCount; index++) {
				expect(callOrNull(() => leftChild(index))).toBe(vector.left[index]);
				expect(callOrNull(() => rightChild(index))).toBe(vector.right[index]);
				expect(callOrNull(() => parentNode(index, vector.leafCount))).toBe(vector.parent[index]);
				expect(callOrNull(() => siblingNode(index, vector.leafCount))).toBe(vector.sibling[index]);
			}
		}
	});

	test('computes node and leaf indexes without signed 32-bit overflow', () => {
		expect(nodeWidth(MAX_MLS_TREE_LEAVES)).toBe(MAX_MLS_TREE_NODES);
		expect(treeRoot(MAX_MLS_TREE_LEAVES)).toBe(0x7fff_ffff);
		expect(leafNodeIndex(MAX_MLS_TREE_LEAVES - 1)).toBe(0xffff_fffe);
		expect(nodeLevel(0x7fff_ffff)).toBe(31);
		expect(() => nodeWidth(MAX_MLS_TREE_LEAVES + 1)).toThrow(RangeError);
		expect(() => leafNodeIndex(MAX_MLS_TREE_LEAVES)).toThrow(RangeError);
	});

	test('returns direct paths and copaths from leaf to root', () => {
		expect(directPath(0, 8)).toEqual([1, 3, 7]);
		expect(copath(0, 8)).toEqual([2, 5, 11]);
		expect(directPath(7, 8)).toEqual([]);
		expect(copath(7, 8)).toEqual([]);
	});
});

describe('MLS ratchet tree operations', () => {
	test('matches official ciphersuite 2 resolutions and tree hashes', () => {
		const tree = decodeRatchetTree(hex(OFFICIAL_SUITE_2_TREE.encoded));
		assertRatchetTree(tree);
		for (let index = 0; index < OFFICIAL_SUITE_2_TREE.resolutions.length; index++) {
			expect(resolution(tree, index)).toEqual(OFFICIAL_SUITE_2_TREE.resolutions[index]);
			expect(toHex(treeHash(provider, tree, index))).toBe(OFFICIAL_SUITE_2_TREE.treeHashes[index]);
		}
		expect(toHex(treeHash(provider, tree))).toBe(OFFICIAL_SUITE_2_TREE.treeHashes[1]);
		expect(validateParentHashes(provider, tree)).toBe(true);
	});

	test('matches the official ciphersuite 2 compact tree with trailing blanks', () => {
		const tree = decodeRatchetTree(hex(OFFICIAL_SUITE_2_COMPACT_TREE.encoded));
		expect(tree).toHaveLength(5);
		for (let index = 0; index < OFFICIAL_SUITE_2_COMPACT_TREE.resolutions.length; index++) {
			expect(resolution(tree, index)).toEqual(OFFICIAL_SUITE_2_COMPACT_TREE.resolutions[index]);
			expect(toHex(treeHash(provider, tree, index))).toBe(OFFICIAL_SUITE_2_COMPACT_TREE.treeHashes[index]);
		}
		expect(validateParentHashes(provider, tree)).toBe(true);
	});

	test('synthesizes the minimum logical capacity from a compact final leaf', () => {
		const compact = [leaf('A'), undefined, leaf('B'), undefined, leaf('C')];
		assertRatchetTree(compact);
		expect(resolution(compact, 3)).toEqual([0, 2, 4]);
		expect(directPath(leafNodeIndex(2), 4)).toEqual([5, 3]);
		expect(addLeaf(compact, leafNode('D')).leafIndex).toBe(3);
	});

	test('adds to the leftmost blank leaf and tracks it as unmerged', () => {
		const tree = [leaf('A'), parent('P')];
		const added = addLeaf(tree, leafNode('B'));
		expect(added.leafIndex).toBe(1);
		expect(added.tree).toHaveLength(3);
		expect(added.tree[2]).toEqual(leaf('B'));
		expect(parentAt(added.tree, 1).unmergedLeaves).toEqual([1]);
		expect(Object.isFrozen(added.tree)).toBe(true);
	});

	test('extends, removes, truncates and reuses leaf positions', () => {
		const full = [leaf('A'), parent('P'), leaf('B')];
		const extended = addLeaf(full, leafNode('C'));
		expect(extended.leafIndex).toBe(2);
		expect(extended.tree).toHaveLength(5);
		expect(resolution(extended.tree, 3)).toEqual([1, 4]);

		const removed = removeLeaf(extended.tree, 2);
		expect(removed).toHaveLength(3);
		expect(resolution(removed, 1)).toEqual([1]);

		const reused = addLeaf(removed, leafNode('D'));
		expect(reused.leafIndex).toBe(2);
		expect(reused.tree).toHaveLength(5);
	});

	test('filters direct-path nodes whose copath resolution is empty', () => {
		const tree = [
			leaf('A'),
			parent('T'),
			leaf('B'),
			undefined,
			undefined,
			undefined,
			undefined,
			parent('W'),
			leaf('E'),
		];
		expect(filteredDirectPath(tree, 0)).toEqual([1, 7]);
		expect(filteredDirectPath(tree, 4)).toEqual([7]);
		expect(() => filteredDirectPath(tree, 2)).toThrow(/non-blank leaf/);
	});

	test('rejects malformed node placement and unmerged leaf references', () => {
		expect(() => assertRatchetTree([parent('P')])).toThrow(/leaf node/);
		expect(() => assertRatchetTree([leaf('A'), undefined])).toThrow(/trailing blank/);
		expect(() => assertRatchetTree([leaf('A'), parent('P', [1])])).toThrow(/non-blank/);
		expect(() => removeLeaf([leaf('A')], 1)).toThrow(RangeError);
	});
});

describe('MLS parent hashes', () => {
	test('computes and validates one parent-hash chain', () => {
		const initial = [leaf('A'), parent('P'), leaf('B')];
		const expected = computeParentHash(provider, initial, 1, 2);
		const tree = [commitLeaf('A', expected), parent('P'), leaf('B')];
		expect(validateParentHash(provider, tree, 0, 1)).toBe(true);
		expect(validateParentHashes(provider, tree)).toBe(true);
	});

	test('rejects altered and multiply-covered parent-hash chains', () => {
		const initial = [leaf('A'), parent('P'), leaf('B')];
		const leftHash = computeParentHash(provider, initial, 1, 2);
		const rightHash = computeParentHash(provider, initial, 1, 0);
		const altered = [
			commitLeaf('A', Uint8Array.of(...leftHash.slice(0, -1), (leftHash.at(-1) as number) ^ 1)),
			parent('P'),
			leaf('B'),
		];
		expect(validateParentHashes(provider, altered)).toBe(false);
		const coveredTwice = [commitLeaf('A', leftHash), parent('P'), commitLeaf('B', rightHash)];
		expect(validateParentHashes(provider, coveredTwice)).toBe(false);
	});
});

function callOrNull(operation: () => number): number | null {
	try {
		return operation();
	} catch {
		return null;
	}
}

function leaf(identity: string): MlsNode {
	return { type: NodeType.Leaf, leafNode: leafNode(identity) };
}

function commitLeaf(identity: string, parentHash: Uint8Array): MlsNode {
	return {
		type: NodeType.Leaf,
		leafNode: { ...leafNode(identity), source: { type: LeafNodeSource.Commit, parentHash } },
	};
}

function leafNode(identity: string): MlsLeafNode {
	const bytes = new TextEncoder().encode(identity);
	return {
		encryptionKey: bytes,
		signatureKey: bytes,
		credential: { type: CredentialType.Basic, identity: bytes },
		capabilities: { versions: [1], cipherSuites: [2], extensions: [], proposals: [], credentials: [1] },
		source: { type: LeafNodeSource.Update },
		extensions: [],
		signature: bytes,
	};
}

function parent(identity: string, unmergedLeaves: readonly number[] = []): MlsNode {
	return {
		type: NodeType.Parent,
		parentNode: { encryptionKey: new TextEncoder().encode(identity), parentHash: new Uint8Array(), unmergedLeaves },
	};
}

function parentAt(tree: MlsRatchetTree, index: number): MlsParentNode {
	const node = tree[index];
	if (node?.type !== NodeType.Parent) throw new TypeError('Expected a parent node.');
	return node.parentNode;
}

function hex(value: string): Uint8Array {
	return Buffer.from(value, 'hex');
}

function toHex(value: Uint8Array): string {
	return Buffer.from(value).toString('hex');
}
