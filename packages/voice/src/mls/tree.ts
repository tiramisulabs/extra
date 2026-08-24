import { equalBytes } from '../bytes';
import type { VoiceCryptoProvider } from '../crypto/provider';
import { assertUnsignedInteger, MlsWriter } from './codec';
import {
	encodeLeafNode,
	encodeParentNode,
	LeafNodeSource,
	type MlsLeafNode,
	type MlsNode,
	type MlsParentNode,
	NodeType,
} from './protocol';

export const MAX_MLS_TREE_LEAVES = 0x8000_0000;
export const MAX_MLS_TREE_NODES = 0xffff_ffff;

const EMPTY = new Uint8Array();

export type MlsRatchetTree = readonly (MlsNode | undefined)[];

export interface AddLeafResult {
	readonly tree: MlsRatchetTree;
	readonly leafIndex: number;
}

export function nodeLevel(nodeIndex: number): number {
	assertNodeIndex(nodeIndex);
	let value = BigInt(nodeIndex);
	if ((value & 1n) === 0n) return 0;
	let level = 0;
	while ((value & 1n) === 1n) {
		level++;
		value >>= 1n;
	}
	return level;
}

export function nodeWidth(leafCount: number): number {
	assertLeafCount(leafCount, true);
	return leafCount === 0 ? 0 : 2 * leafCount - 1;
}

export function leafNodeIndex(leafIndex: number): number {
	assertUnsignedInteger(leafIndex, MAX_MLS_TREE_LEAVES - 1, 'leafIndex');
	return 2 * leafIndex;
}

export function leafIndex(nodeIndex: number): number {
	assertNodeIndex(nodeIndex);
	if (nodeIndex % 2 !== 0) throw new TypeError('MLS parent nodes do not have leaf indexes.');
	return nodeIndex / 2;
}

export function treeRoot(leafCount: number): number {
	assertLeafCount(leafCount, false);
	let power = 1n;
	const width = BigInt(nodeWidth(leafCount));
	while (power << 1n <= width) power <<= 1n;
	return Number(power - 1n);
}

export function leftChild(nodeIndex: number): number {
	const level = nodeLevel(nodeIndex);
	if (level === 0) throw new TypeError('MLS leaf nodes do not have children.');
	return toNodeIndex(BigInt(nodeIndex) ^ (1n << BigInt(level - 1)));
}

export function rightChild(nodeIndex: number): number {
	const level = nodeLevel(nodeIndex);
	if (level === 0) throw new TypeError('MLS leaf nodes do not have children.');
	return toNodeIndex(BigInt(nodeIndex) ^ (3n << BigInt(level - 1)));
}

export function parentNode(nodeIndex: number, leafCount: number): number {
	assertPerfectTreeLeafCount(leafCount);
	assertNodeInTree(nodeIndex, leafCount);
	if (nodeIndex === treeRoot(leafCount)) throw new TypeError('The MLS root node does not have a parent.');
	const value = BigInt(nodeIndex);
	const level = BigInt(nodeLevel(nodeIndex));
	const direction = (value >> (level + 1n)) & 1n;
	return toNodeIndex((value | (1n << level)) ^ (direction << (level + 1n)));
}

export function siblingNode(nodeIndex: number, leafCount: number): number {
	const parent = parentNode(nodeIndex, leafCount);
	return nodeIndex < parent ? rightChild(parent) : leftChild(parent);
}

export function directPath(nodeIndex: number, leafCount: number): readonly number[] {
	assertPerfectTreeLeafCount(leafCount);
	assertNodeInTree(nodeIndex, leafCount);
	const root = treeRoot(leafCount);
	const path: number[] = [];
	let current = nodeIndex;
	while (current !== root) {
		current = parentNode(current, leafCount);
		path.push(current);
	}
	return path;
}

export function copath(nodeIndex: number, leafCount: number): readonly number[] {
	const path = directPath(nodeIndex, leafCount);
	if (path.length === 0) return [];
	return [nodeIndex, ...path.slice(0, -1)].map(index => siblingNode(index, leafCount));
}

export function assertRatchetTree(tree: MlsRatchetTree): void {
	if (!Array.isArray(tree)) throw new TypeError('MLS ratchet tree must be an array.');
	if (tree.length > MAX_MLS_TREE_NODES) throw new RangeError('MLS ratchet tree exceeds the supported node limit.');
	if (tree.length > 0 && tree.at(-1) === undefined) {
		throw new TypeError('MLS ratchet tree must omit trailing blank nodes.');
	}
	const leafCount = logicalLeafCount(tree);
	for (let index = 0; index < tree.length; index++) {
		const node = tree[index];
		if (node === undefined) continue;
		if (index % 2 === 0) {
			if (node.type !== NodeType.Leaf) throw new TypeError(`MLS node ${index} must contain a leaf node.`);
			continue;
		}
		if (node.type !== NodeType.Parent) throw new TypeError(`MLS node ${index} must contain a parent node.`);
		assertUnmergedLeaves(tree, index, node.parentNode.unmergedLeaves, leafCount);
	}
}

export function resolution(tree: MlsRatchetTree, nodeIndex: number): readonly number[] {
	assertRatchetTree(tree);
	const leafCount = requireNonEmptyTree(tree);
	assertNodeInTree(nodeIndex, leafCount);
	return resolutionInternal(tree, nodeIndex);
}

export function filteredDirectPath(tree: MlsRatchetTree, memberLeafIndex: number): readonly number[] {
	assertRatchetTree(tree);
	const leafCount = requireNonEmptyTree(tree);
	assertLeafInTree(memberLeafIndex, leafCount);
	const nodeIndex = leafNodeIndex(memberLeafIndex);
	if (tree[nodeIndex]?.type !== NodeType.Leaf) {
		throw new TypeError('MLS filtered direct path requires a non-blank leaf.');
	}
	const path = directPath(nodeIndex, leafCount);
	const siblings = copath(nodeIndex, leafCount);
	return path.filter((_, index) => resolutionInternal(tree, siblings[index] as number).length > 0);
}

export function addLeaf(tree: MlsRatchetTree, leafNode: MlsLeafNode): AddLeafResult {
	assertRatchetTree(tree);
	let leafCount = logicalLeafCount(tree);
	let nodes = materializeTree(tree, leafCount);
	if (leafCount === 0) {
		leafCount = 1;
		nodes = [undefined];
	}
	let memberLeafIndex = findBlankLeaf(nodes, leafCount);
	if (memberLeafIndex === undefined) {
		if (leafCount === MAX_MLS_TREE_LEAVES) throw new RangeError('MLS ratchet tree cannot be extended further.');
		memberLeafIndex = leafCount;
		leafCount *= 2;
		nodes.length = nodeWidth(leafCount);
		nodes.fill(undefined, tree.length);
	}
	const nodeIndex = leafNodeIndex(memberLeafIndex);
	for (const pathIndex of directPath(nodeIndex, leafCount)) {
		const pathNode = nodes[pathIndex];
		if (pathNode?.type !== NodeType.Parent) continue;
		const unmergedLeaves = insertSorted(pathNode.parentNode.unmergedLeaves, memberLeafIndex);
		nodes[pathIndex] = freezeParentNode({ ...pathNode.parentNode, unmergedLeaves });
	}
	nodes[nodeIndex] = Object.freeze({ type: NodeType.Leaf, leafNode });
	const result = freezeTree(compactTree(nodes));
	assertRatchetTree(result);
	return Object.freeze({ tree: result, leafIndex: memberLeafIndex });
}

export function removeLeaf(tree: MlsRatchetTree, memberLeafIndex: number): MlsRatchetTree {
	assertRatchetTree(tree);
	const leafCount = requireNonEmptyTree(tree);
	assertLeafInTree(memberLeafIndex, leafCount);
	const nodeIndex = leafNodeIndex(memberLeafIndex);
	if (tree[nodeIndex]?.type !== NodeType.Leaf) throw new TypeError('MLS removal target must be a non-blank leaf.');
	const nodes = materializeTree(tree, leafCount);
	nodes[nodeIndex] = undefined;
	for (const pathIndex of directPath(nodeIndex, leafCount)) nodes[pathIndex] = undefined;
	return truncateMaterializedTree(nodes, leafCount);
}

export function truncateTree(tree: MlsRatchetTree): MlsRatchetTree {
	assertRatchetTree(tree);
	const leafCount = logicalLeafCount(tree);
	if (leafCount === 0) return tree;
	return truncateMaterializedTree(materializeTree(tree, leafCount), leafCount);
}

export function treeHash(provider: VoiceCryptoProvider, tree: MlsRatchetTree, nodeIndex?: number): Uint8Array {
	assertRatchetTree(tree);
	const leafCount = requireNonEmptyTree(tree);
	const target = nodeIndex ?? treeRoot(leafCount);
	assertNodeInTree(target, leafCount);
	return treeHashInternal(provider, tree, target, new Map());
}

export function computeParentHash(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	parentIndex: number,
	copathChildIndex: number,
): Uint8Array {
	assertRatchetTree(tree);
	const leafCount = requireNonEmptyTree(tree);
	assertNodeInTree(parentIndex, leafCount);
	assertNodeInTree(copathChildIndex, leafCount);
	return computeParentHashInternal(provider, tree, leafCount, parentIndex, copathChildIndex);
}

export function validateParentHash(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	descendantIndex: number,
	parentIndex: number,
): boolean {
	try {
		assertRatchetTree(tree);
		const leafCount = requireNonEmptyTree(tree);
		assertNodeInTree(descendantIndex, leafCount);
		assertNodeInTree(parentIndex, leafCount);
		return validateParentHashInternal(provider, tree, leafCount, descendantIndex, parentIndex);
	} catch {
		return false;
	}
}

export function validateParentHashes(provider: VoiceCryptoProvider, tree: MlsRatchetTree): boolean {
	try {
		assertRatchetTree(tree);
		const leafCount = requireNonEmptyTree(tree);
		const root = treeRoot(leafCount);
		for (let parentIndex = 1; parentIndex < tree.length; parentIndex += 2) {
			const parent = tree[parentIndex];
			if (parent?.type !== NodeType.Parent) continue;
			if (parentIndex === root && parent.parentNode.parentHash.byteLength !== 0) return false;
			let validDescendants = 0;
			for (const childIndex of [leftChild(parentIndex), rightChild(parentIndex)]) {
				for (const descendantIndex of resolutionInternal(tree, childIndex)) {
					if (!validateParentHashInternal(provider, tree, leafCount, descendantIndex, parentIndex)) continue;
					validDescendants++;
					if (validDescendants > 1) return false;
				}
			}
			if (validDescendants !== 1) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function assertUnmergedLeaves(
	tree: MlsRatchetTree,
	parentIndex: number,
	unmergedLeaves: readonly number[],
	leafCount: number,
): void {
	let previous = -1;
	for (const memberLeafIndex of unmergedLeaves) {
		assertLeafInTree(memberLeafIndex, leafCount);
		if (memberLeafIndex <= previous) throw new TypeError('MLS parent unmerged leaves must be strictly increasing.');
		previous = memberLeafIndex;
		const nodeIndex = leafNodeIndex(memberLeafIndex);
		if (tree[nodeIndex]?.type !== NodeType.Leaf) {
			throw new TypeError('MLS parent unmerged leaves must refer to non-blank leaves.');
		}
		if (!isDescendantInternal(nodeIndex, parentIndex, leafCount)) {
			throw new TypeError('MLS parent unmerged leaves must be descendants of that parent.');
		}
		let current = nodeIndex;
		while (current !== parentIndex) {
			current = parentNode(current, leafCount);
			if (current === parentIndex) break;
			const intermediate = tree[current];
			if (intermediate?.type === NodeType.Parent && !intermediate.parentNode.unmergedLeaves.includes(memberLeafIndex)) {
				throw new TypeError('MLS unmerged leaves must be present in every non-blank intermediate parent.');
			}
		}
	}
}

function resolutionInternal(tree: MlsRatchetTree, nodeIndex: number): number[] {
	const node = tree[nodeIndex];
	if (node?.type === NodeType.Leaf) return [nodeIndex];
	if (node?.type === NodeType.Parent) {
		return [nodeIndex, ...node.parentNode.unmergedLeaves.map(leafNodeIndex)];
	}
	if (nodeIndex % 2 === 0) return [];
	return [...resolutionInternal(tree, leftChild(nodeIndex)), ...resolutionInternal(tree, rightChild(nodeIndex))];
}

function truncateMaterializedTree(nodes: (MlsNode | undefined)[], initialLeafCount: number): MlsRatchetTree {
	let leafCount = initialLeafCount;
	while (leafCount > 1) {
		const root = treeRoot(leafCount);
		if (resolutionInternal(nodes, rightChild(root)).length > 0) break;
		leafCount /= 2;
		nodes.length = nodeWidth(leafCount);
	}
	const result = freezeTree(compactTree(nodes));
	assertRatchetTree(result);
	return result;
}

function treeHashInternal(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	nodeIndex: number,
	cache: Map<number, Uint8Array>,
): Uint8Array {
	const cached = cache.get(nodeIndex);
	if (cached !== undefined) return cached;
	const node = tree[nodeIndex];
	let input: Uint8Array;
	if (nodeIndex % 2 === 0) {
		const leafNode = node?.type === NodeType.Leaf ? node.leafNode : undefined;
		const writer = new MlsWriter().uint8(NodeType.Leaf).uint32(leafIndex(nodeIndex));
		writer.optional(leafNode, (output, value) => {
			output.bytes(encodeLeafNode(value));
		});
		input = writer.finish();
	} else {
		const parent = node?.type === NodeType.Parent ? node.parentNode : undefined;
		const writer = new MlsWriter().uint8(NodeType.Parent);
		writer.optional(parent, (output, value) => {
			output.bytes(encodeParentNode(value));
		});
		writer
			.vector(treeHashInternal(provider, tree, leftChild(nodeIndex), cache))
			.vector(treeHashInternal(provider, tree, rightChild(nodeIndex), cache));
		input = writer.finish();
	}
	const hash = provider.sha256(input);
	cache.set(nodeIndex, hash);
	return hash;
}

function computeParentHashInternal(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	leafCount: number,
	parentIndex: number,
	copathChildIndex: number,
): Uint8Array {
	const node = tree[parentIndex];
	if (node?.type !== NodeType.Parent) throw new TypeError('MLS parent hash requires a non-blank parent node.');
	const left = leftChild(parentIndex);
	const right = rightChild(parentIndex);
	if (copathChildIndex !== left && copathChildIndex !== right) {
		throw new TypeError('MLS parent hash copath node must be an immediate child of the parent.');
	}
	const excludedLeaves = new Set(node.parentNode.unmergedLeaves);
	const originalTree = excludeUnmergedLeaves(tree, excludedLeaves);
	const originalSiblingTreeHash = treeHashInternal(provider, originalTree, copathChildIndex, new Map());
	const chainedParentHash = parentIndex === treeRoot(leafCount) ? EMPTY : node.parentNode.parentHash;
	return provider.sha256(
		new MlsWriter()
			.vector(node.parentNode.encryptionKey)
			.vector(chainedParentHash)
			.vector(originalSiblingTreeHash)
			.finish(),
	);
}

function validateParentHashInternal(
	provider: VoiceCryptoProvider,
	tree: MlsRatchetTree,
	leafCount: number,
	descendantIndex: number,
	parentIndex: number,
): boolean {
	if (descendantIndex === parentIndex || !isDescendantInternal(descendantIndex, parentIndex, leafCount)) return false;
	const parent = tree[parentIndex];
	const descendant = tree[descendantIndex];
	if (parent?.type !== NodeType.Parent || descendant === undefined) return false;
	const directChild = descendantIndex < parentIndex ? leftChild(parentIndex) : rightChild(parentIndex);
	const copathChild = directChild === leftChild(parentIndex) ? rightChild(parentIndex) : leftChild(parentIndex);
	const childResolution = resolutionInternal(tree, directChild);
	if (!childResolution.includes(descendantIndex)) return false;
	const otherResolutionNodes = childResolution.filter(index => index !== descendantIndex);
	const expectedUnmergedNodes = parent.parentNode.unmergedLeaves
		.map(leafNodeIndex)
		.filter(index => isDescendantInternal(index, directChild, leafCount));
	if (!equalNumbers(otherResolutionNodes, expectedUnmergedNodes)) return false;
	const actualParentHash = parentHashOf(descendant);
	if (actualParentHash === undefined) return false;
	return equalBytes(actualParentHash, computeParentHashInternal(provider, tree, leafCount, parentIndex, copathChild));
}

function excludeUnmergedLeaves(tree: MlsRatchetTree, excludedLeaves: ReadonlySet<number>): MlsRatchetTree {
	if (excludedLeaves.size === 0) return tree;
	const nodes = [...tree];
	for (const memberLeafIndex of excludedLeaves) nodes[leafNodeIndex(memberLeafIndex)] = undefined;
	for (let index = 1; index < nodes.length; index += 2) {
		const node = nodes[index];
		if (node?.type !== NodeType.Parent) continue;
		const unmergedLeaves = node.parentNode.unmergedLeaves.filter(value => !excludedLeaves.has(value));
		if (unmergedLeaves.length === node.parentNode.unmergedLeaves.length) continue;
		nodes[index] = freezeParentNode({ ...node.parentNode, unmergedLeaves });
	}
	return nodes;
}

function parentHashOf(node: MlsNode): Uint8Array | undefined {
	if (node.type === NodeType.Parent) return node.parentNode.parentHash;
	return node.leafNode.source.type === LeafNodeSource.Commit ? node.leafNode.source.parentHash : undefined;
}

/** @internal */
export function logicalLeafCount(tree: MlsRatchetTree): number {
	if (tree.length === 0) return 0;
	const minimum = Math.ceil((tree.length + 1) / 2);
	let leafCount = 1;
	while (leafCount < minimum) leafCount *= 2;
	if (leafCount > MAX_MLS_TREE_LEAVES) throw new RangeError('MLS ratchet tree exceeds the supported leaf limit.');
	return leafCount;
}

function requireNonEmptyTree(tree: MlsRatchetTree): number {
	const leafCount = logicalLeafCount(tree);
	if (leafCount === 0) throw new TypeError('MLS ratchet tree must contain at least one non-blank node.');
	return leafCount;
}

function materializeTree(tree: MlsRatchetTree, leafCount: number): (MlsNode | undefined)[] {
	return Array.from({ length: nodeWidth(leafCount) }, (_, index) => tree[index]);
}

/** @internal */
export function compactTree(nodes: readonly (MlsNode | undefined)[]): (MlsNode | undefined)[] {
	let length = nodes.length;
	while (length > 0 && nodes[length - 1] === undefined) length--;
	return nodes.slice(0, length);
}

function findBlankLeaf(nodes: readonly (MlsNode | undefined)[], leafCount: number): number | undefined {
	for (let index = 0; index < leafCount; index++) {
		if (nodes[leafNodeIndex(index)] === undefined) return index;
	}
	return undefined;
}

function insertSorted(values: readonly number[], value: number): readonly number[] {
	const result = [...values];
	const position = result.findIndex(current => current > value);
	result.splice(position === -1 ? result.length : position, 0, value);
	return Object.freeze(result);
}

function freezeParentNode(parentNode: MlsParentNode): MlsNode {
	return Object.freeze({
		type: NodeType.Parent,
		parentNode: Object.freeze({ ...parentNode, unmergedLeaves: Object.freeze([...parentNode.unmergedLeaves]) }),
	});
}

function freezeTree(nodes: (MlsNode | undefined)[]): MlsRatchetTree {
	return Object.freeze(nodes);
}

function isDescendantInternal(nodeIndex: number, ancestorIndex: number, leafCount: number): boolean {
	if (nodeIndex === ancestorIndex) return true;
	const root = treeRoot(leafCount);
	let current = nodeIndex;
	while (current !== root) {
		current = parentNode(current, leafCount);
		if (current === ancestorIndex) return true;
	}
	return false;
}

function assertLeafInTree(memberLeafIndex: number, leafCount: number): void {
	assertUnsignedInteger(memberLeafIndex, leafCount - 1, 'leafIndex');
}

function assertNodeInTree(nodeIndex: number, leafCount: number): void {
	assertNodeIndex(nodeIndex);
	if (nodeIndex >= nodeWidth(leafCount)) throw new RangeError('nodeIndex is outside the MLS ratchet tree.');
}

function assertNodeIndex(nodeIndex: number): void {
	assertUnsignedInteger(nodeIndex, MAX_MLS_TREE_NODES - 1, 'nodeIndex');
}

function assertPerfectTreeLeafCount(leafCount: number): void {
	assertLeafCount(leafCount, false);
	if (!Number.isInteger(Math.log2(leafCount))) throw new RangeError('MLS tree leafCount must be a power of two.');
}

function assertLeafCount(leafCount: number, allowZero: boolean): void {
	assertUnsignedInteger(leafCount, MAX_MLS_TREE_LEAVES, 'leafCount');
	if (!allowZero && leafCount === 0) throw new RangeError('leafCount must be positive.');
}

function toNodeIndex(value: bigint): number {
	if (value < 0n || value >= BigInt(MAX_MLS_TREE_NODES)) throw new RangeError('nodeIndex is out of range.');
	return Number(value);
}

function equalNumbers(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
