import { assert, describe, expect, expectTypeOf, test } from 'vitest';
import {
	type CausalPosition,
	GLOBAL_VISIBILITY_SCOPE,
	ReconciliationState,
	type ShardGeneration,
	snapshotArrayField,
} from '../src/reconciliation-state';

function activeState(): ReconciliationState {
	const state = new ReconciliationState();
	state.activate();
	return state;
}

function ready(
	state: ReconciliationState,
	input: Partial<{ expectedGuildIds: string[]; sequence: number; sessionId: string; shardId: number }> = {},
): ShardGeneration {
	const generation = state.openGeneration({
		expectedGuildIds: input.expectedGuildIds ?? [],
		sequence: input.sequence ?? 1,
		sessionId: input.sessionId ?? 'session-a',
		shardId: input.shardId ?? 0,
	});
	if (input.expectedGuildIds === undefined) state.markGuildsReady(generation);
	return generation;
}

function writeVisible(state: ReconciliationState, key: string, generation: ShardGeneration, sequence: number): void {
	const position = state.observePacket(generation, sequence);
	const write = state.stageWrite(key, position);
	assert.isTrue(state.beginWrite(write));
	assert.equal(state.completeWrite(write, true), 'committed');
}

function snapshot(
	state: ReconciliationState,
	generation: ShardGeneration,
	sequence: number,
	resource = 'roles',
	completeness: 'authoritative' | 'partial' = 'authoritative',
) {
	return state.beginSnapshot(generation, sequence, { completeness, guildId: 'guild-a', resource });
}

describe('ReconciliationState lifecycle and work', () => {
	test('cancels queued reconciliation work while closing', async () => {
		const state = new ReconciliationState();
		assert.equal(state.lifecycle, 'installing');
		expect(() => state.registerWork()).toThrow(/not active/);
		state.activate();
		const work = state.registerWork({ label: 'guild snapshot' });
		assert.isFalse(state.settleWork(work));
		let idle = false;
		const waiting = state.waitForIdle().then(() => {
			idle = true;
		});

		state.beginClosing();
		expect(() => state.registerWork()).toThrow(/not active/);
		await waiting;
		assert.isTrue(idle);
		assert.isFalse(state.settleWork(work));
		state.finishClosing();

		assert.equal(state.lifecycle, 'closed');
		expect(() => state.activate()).toThrow(/Cannot activate/);
	});

	test('drains executing reconciliation work while closing', async () => {
		const state = activeState();
		const work = state.registerWork({ label: 'running sweep' });
		assert.isTrue(state.beginWork(work));
		const waiting = state.waitForIdle();
		state.beginClosing();
		expect(() => state.finishClosing()).toThrow(/work is pending/);
		assert.isTrue(state.settleWork(work));
		await waiting;
		state.finishClosing();
	});

	test('failed is terminal for admission but may transition through cleanup to closed', () => {
		const state = activeState();
		state.fail();
		assert.equal(state.lifecycle, 'failed');
		expect(() => ready(state)).toThrow(/not active/);
		state.beginClosing();
		state.finishClosing();
		state.fail();
		assert.equal(state.lifecycle, 'closed');
	});

	test('failure cancels queued work and drains executing work through its owner', async () => {
		const state = activeState();
		const queued = state.registerWork({ label: 'queued' });
		const executing = state.registerWork({ label: 'executing' });
		assert.isTrue(state.beginWork(executing));
		state.fail();
		assert.isFalse(state.settleWork(queued));
		assert.equal(state.pendingWork, 1);
		const waiting = state.waitForIdle();
		assert.isTrue(state.settleWork(executing));
		await waiting;
		state.beginClosing();
		state.finishClosing();
	});

	test('drains an in-flight write before closing', async () => {
		const state = activeState();
		const generation = ready(state);
		const write = state.stageWrite('roles:pending', state.observePacket(generation, 2));
		assert.isTrue(state.beginWrite(write));
		const waiting = state.waitForIdle();
		assert.equal(state.pendingWork, 1);
		state.beginClosing();
		expect(() => state.finishClosing()).toThrow(/work is pending/);
		assert.equal(state.completeWrite(write, true), 'stale');
		await waiting;
		state.finishClosing();
		assert.equal(state.lifecycle, 'closed');
	});
});

describe('ReconciliationState shard generations', () => {
	test('owns READY as pending work until the complete startup barrier commits', async () => {
		const state = activeState();
		const generation = ready(state, { expectedGuildIds: ['late'] });
		let idle = false;
		const waiting = state.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		assert.isFalse(idle);
		assert.equal(state.pendingWork, 1);
		assert.isFalse(state.markGuildsReady(generation));
		await Promise.resolve();
		assert.isFalse(idle);
		assert.isTrue(state.markGuildOutcome(generation, 'late', 'reconciled'));
		await waiting;
		assert.equal(state.pendingWork, 0);
	});

	test('replaces an incomplete READY barrier without exposing a transient idle state', async () => {
		const state = activeState();
		ready(state, { expectedGuildIds: ['never-arrives'], sessionId: 'old' });
		let idle = false;
		const waiting = state.waitForIdle().then(() => {
			idle = true;
		});
		const replacement = ready(state, { expectedGuildIds: [], sequence: 1, sessionId: 'new' });
		await Promise.resolve();
		assert.isFalse(idle);
		assert.equal(state.pendingWork, 1);
		assert.isTrue(state.markGuildsReady(replacement));
		await waiting;
		assert.equal(state.pendingWork, 0);
	});

	test('tracks all terminal guild outcomes and commits only after GUILDS_READY and the final outcome', () => {
		const outcomes = ['reconciled', 'unavailable-preserved', 'disabled-preserved', 'deleted', 'failure'] as const;
		const state = activeState();
		const generation = ready(state, { expectedGuildIds: ['a', 'b', 'c', 'd', 'e'] });

		assert.isFalse(state.markGuildOutcome(generation, 'a', outcomes[0]));
		assert.isFalse(state.markGuildOutcome(generation, 'b', outcomes[1]));
		assert.isFalse(state.markGuildOutcome(generation, 'c', outcomes[2]));
		assert.isFalse(state.markGuildOutcome(generation, 'd', outcomes[3]));
		assert.isFalse(state.markGuildsReady(generation));
		assert.isFalse(state.generationStatus(generation).committed);
		assert.isTrue(state.markGuildOutcome(generation, 'e', outcomes[4]));
		assert.deepEqual(state.generationStatus(generation).guildOutcomes, {
			a: 'reconciled',
			b: 'unavailable-preserved',
			c: 'disabled-preserved',
			d: 'deleted',
			e: 'failure',
		});
		assert.isTrue(state.isCurrentGeneration(generation));
	});

	test('GUILDS_READY can overtake late registration and a zero-guild READY commits immediately', async () => {
		const state = activeState();
		const late = ready(state, { expectedGuildIds: ['late'] });
		assert.isFalse(state.markGuildsReady(late));
		const work = state.registerWork({ generation: late, label: 'late RAW_GUILD_CREATE' });
		assert.isFalse(state.generationStatus(late).committed);
		assert.isTrue(state.beginWork(work));
		assert.isTrue(state.settleWork(work));
		assert.isTrue(state.markGuildOutcome(late, 'late', 'reconciled'));
		await state.waitForIdle();

		const empty = ready(state, { expectedGuildIds: [], sequence: 2, sessionId: 'empty' });
		assert.equal(state.pendingWork, 1);
		assert.isTrue(state.markGuildsReady(empty));
		assert.isTrue(state.generationStatus(empty).committed);
	});

	test('same-instance RESUMED continues a generation while a replacement waits for READY', () => {
		const state = activeState();
		const generation = ready(state, { sequence: 12 });
		assert.deepEqual(state.resume(0, 13), generation);
		assert.equal(state.generationStatus(generation).latestSequence, 13);

		const replacement = activeState();
		assert.equal(replacement.resume(0, 13), undefined);
		assert.isTrue(replacement.isAwaitingReady(0));
		const replacementGeneration = ready(replacement, { sequence: 1, sessionId: 'fresh' });
		assert.isFalse(replacement.isAwaitingReady(0));
		assert.isTrue(replacement.isCurrentGeneration(replacementGeneration));
	});

	test('keeps shards independent and allows sequence reset only through a new READY', () => {
		const state = activeState();
		const shardZero = ready(state, { sequence: 500, sessionId: 'zero', shardId: 0 });
		const shardOne = ready(state, { sequence: 900, sessionId: 'one', shardId: 1 });
		state.observePacket(shardZero, 501);
		state.observePacket(shardOne, 901);
		expect(() => state.observePacket(shardZero, 499)).toThrow(/precedes/);

		const replacement = ready(state, { sequence: 1, sessionId: 'zero-next', shardId: 0 });
		assert.isFalse(state.isCurrentGeneration(shardZero));
		assert.isTrue(state.isCurrentGeneration(replacement));
		assert.isTrue(state.isCurrentGeneration(shardOne));
		assert.equal(state.observePacket(replacement, 2).sequence, 2);
	});
});

describe('ReconciliationState visibility fencing', () => {
	test('keeps unavailable partial evidence non-destructive until a later complete snapshot', () => {
		const state = activeState();
		const generation = ready(state);
		const partial = snapshot(state, generation, 2, 'roles', 'partial');
		assert.isTrue(state.preserveUnknown('roles:unavailable', partial));
		assert.equal(state.claimDelete('roles:unavailable', partial), undefined);
		assert.equal(state.visibilityOf('roles:unavailable', generation)?.state, 'unknown-preserved');

		const complete = state.claimDelete('roles:unavailable', snapshot(state, generation, 3, 'roles'));
		assert.isDefined(complete);
		assert.isTrue(state.beginPhysicalDelete(complete!));
		assert.equal(state.completeDelete(complete!, true), 'completed');
		assert.equal(state.visibilityOf('roles:unavailable', generation)?.state, 'hidden-pending');
	});

	test('keeps the newest resource cut when an older snapshot prepares later', () => {
		const state = activeState();
		const generation = ready(state);
		const olderPosition = state.observePacket(generation, 2);
		const newerPosition = state.observePacket(generation, 3);
		const newerPartial = state.recordSnapshot(newerPosition, {
			completeness: 'partial',
			guildId: 'guild-a',
			resource: 'stickers',
		});
		const olderAuthoritative = state.recordSnapshot(olderPosition, {
			completeness: 'authoritative',
			guildId: 'guild-a',
			resource: 'stickers',
		});

		assert.equal(state.latestSnapshotCut(generation, { guildId: 'guild-a', resource: 'stickers' }), newerPartial);
		assert.equal(state.claimDelete('stickers:legacy', olderAuthoritative), undefined);
	});

	test('cancels a queued delete and restores visibility when a newer resource cut preserves data', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'stickers:preserved', generation, 2);
		const claim = state.claimDelete('stickers:preserved', snapshot(state, generation, 3, 'stickers'));
		assert.isDefined(claim);
		assert.equal(state.visibilityOf('stickers:preserved', generation)?.state, 'hidden-pending');

		const newerPartial = snapshot(state, generation, 4, 'stickers', 'partial');

		assert.equal(state.latestSnapshotCut(generation, { guildId: 'guild-a', resource: 'stickers' }), newerPartial);
		assert.isFalse(state.isDeleteClaimCurrent(claim!));
		assert.isFalse(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, true), 'stale');
		assert.equal(state.visibilityOf('stickers:preserved', generation)?.state, 'visible');
		assert.isTrue(state.canRead('stickers:preserved', generation));
		await state.waitForIdle();
	});

	test('distinguishes visible, unknown-preserved, and hidden-pending read/delete semantics', () => {
		const state = activeState();
		const generation = ready(state);
		assert.equal(state.visibilityOf('roles:legacy', generation), undefined);
		assert.isFalse(state.canRead('roles:legacy', generation));

		const legacyCut = snapshot(state, generation, 2);
		const legacyClaim = state.claimDelete('roles:legacy', legacyCut);
		assert.isDefined(legacyClaim);
		assert.isTrue(state.beginPhysicalDelete(legacyClaim!));
		assert.equal(state.completeDelete(legacyClaim!, true), 'completed');
		assert.equal(state.visibilityOf('roles:legacy', generation)?.state, 'hidden-pending');

		const oldAuthoritativeCut = snapshot(state, generation, 3);
		const partialCut = snapshot(state, generation, 4, 'roles', 'partial');
		assert.isTrue(state.preserveUnknown('roles:partial', partialCut));
		assert.equal(state.visibilityOf('roles:partial', generation)?.state, 'unknown-preserved');
		assert.equal(state.claimDelete('roles:partial', partialCut), undefined);
		assert.equal(state.claimDelete('roles:partial', oldAuthoritativeCut), undefined);
		const completeClaim = state.claimDelete('roles:partial', snapshot(state, generation, 5));
		assert.isDefined(completeClaim);
		assert.isTrue(state.beginPhysicalDelete(completeClaim!));
		assert.equal(state.completeDelete(completeClaim!, true), 'completed');

		writeVisible(state, 'roles:current', generation, 6);
		assert.isTrue(state.canRead('roles:current', generation));
		const cut = snapshot(state, generation, 7);
		const claim = state.claimDelete('roles:current', cut);
		assert.isDefined(claim);
		assert.equal(state.visibilityOf('roles:current', generation)?.state, 'hidden-pending');
		assert.isFalse(state.canRead('roles:current', generation));
		assert.isTrue(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, true), 'completed');
	});

	test('a later write completed before an older sweep attempts to hide always wins', () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'channels:one', generation, 2);
		const oldCut = snapshot(state, generation, 3, 'channels');
		const later = state.stageWrite('channels:one', state.observePacket(generation, 4));
		assert.isTrue(state.beginWrite(later));
		assert.equal(state.completeWrite(later, true), 'committed');

		assert.equal(state.claimDelete('channels:one', oldCut), undefined);
		assert.isTrue(state.canRead('channels:one', generation));
	});

	test('a point snapshot supersedes only claims for the same target', () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'channels:one', generation, 2);
		writeVisible(state, 'channels:two', generation, 2);
		const collection = snapshot(state, generation, 3, 'channels');
		const one = state.claimDelete('channels:one', collection, 'one');
		const two = state.claimDelete('channels:two', collection, 'two');
		assert.isDefined(one);
		assert.isDefined(two);
		assert.isFalse(state.canRead('channels:one', generation));
		assert.isFalse(state.canRead('channels:two', generation));

		state.beginSnapshot(generation, 4, {
			completeness: 'authoritative',
			guildId: 'guild-a',
			resource: 'channels',
			supersessionTarget: 'one',
		});

		assert.isFalse(state.isDeleteClaimCurrent(one!));
		assert.isTrue(state.canRead('channels:one', generation));
		assert.isTrue(state.isDeleteClaimCurrent(two!));
		assert.isFalse(state.canRead('channels:two', generation));
		assert.isTrue(state.beginPhysicalDelete(two!));
		assert.equal(state.completeDelete(two!, true), 'completed');
	});

	test('claims a physically discovered key whose only visibility belongs to an old generation', () => {
		const state = activeState();
		const oldGeneration = ready(state, { sessionId: 'old' });
		writeVisible(state, 'channels:old', oldGeneration, 2);
		const generation = ready(state, { sequence: 1, sessionId: 'new' });
		const claim = state.claimDelete('channels:old', snapshot(state, generation, 2, 'channels'));
		assert.isDefined(claim);
		assert.isTrue(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, true), 'completed');
	});

	test('retains a delete tombstone that rejects an older queued write', () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'roles:tombstone', generation, 2);
		const olderWrite = state.stageWrite('roles:tombstone', state.observePacket(generation, 3));
		const claim = state.claimDelete('roles:tombstone', snapshot(state, generation, 4));
		assert.isDefined(claim);
		assert.isTrue(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, true), 'completed');
		assert.equal(state.visibilityOf('roles:tombstone', generation)?.state, 'hidden-pending');
		assert.isFalse(state.canRead('roles:tombstone', generation));
		assert.isFalse(state.beginWrite(olderWrite));
		assert.equal(state.visibilityOf('roles:tombstone', generation)?.state, 'hidden-pending');

		const laterWrite = state.stageWrite('roles:tombstone', state.observePacket(generation, 5));
		assert.isTrue(state.beginWrite(laterWrite));
		assert.equal(state.completeWrite(laterWrite, true), 'committed');
		assert.isTrue(state.canRead('roles:tombstone', generation));
	});

	test('retains a delete tombstone against an older position staged after deletion', () => {
		const state = activeState();
		const generation = ready(state);
		const oldPosition = state.observePacket(generation, 2);
		const claim = state.claimDelete('roles:delayed-write', snapshot(state, generation, 3));
		assert.isDefined(claim);
		assert.isTrue(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, true), 'completed');
		assert.equal(state.visibilityOf('roles:delayed-write', generation)?.state, 'hidden-pending');

		const delayedWrite = state.stageWrite('roles:delayed-write', oldPosition);
		assert.isFalse(state.beginWrite(delayedWrite));
		assert.equal(state.visibilityOf('roles:delayed-write', generation)?.state, 'hidden-pending');
		assert.isFalse(state.canRead('roles:delayed-write', generation));
	});

	test('a later staged write prevents an older queued delete and becomes visible only after success', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'channels:two', generation, 2);
		const claim = state.claimDelete('channels:two', snapshot(state, generation, 3, 'channels'));
		assert.isDefined(claim);
		const later = state.stageWrite('channels:two', state.observePacket(generation, 4));
		assert.isFalse(state.beginPhysicalDelete(claim!));
		assert.equal(state.visibilityOf('channels:two', generation)?.state, 'hidden-pending');

		assert.isTrue(state.beginWrite(later));
		assert.equal(state.completeWrite(later, true), 'committed');
		assert.equal(state.completeDelete(claim!, true), 'stale');
		await state.waitForIdle();
		assert.isTrue(state.canRead('channels:two', generation));
	});

	test('a failed later write drains the skipped delete and permits a later retry', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'channels:retry', generation, 2);
		const skipped = state.claimDelete('channels:retry', snapshot(state, generation, 3, 'channels'));
		assert.isDefined(skipped);
		const laterWrite = state.stageWrite('channels:retry', state.observePacket(generation, 4));
		assert.equal(state.pendingWork, 2);
		assert.isFalse(state.beginPhysicalDelete(skipped!));
		assert.equal(state.pendingWork, 1);
		assert.equal(state.completeDelete(skipped!, true), 'stale');
		assert.isTrue(state.beginWrite(laterWrite));
		assert.equal(state.completeWrite(laterWrite, false), 'failed');
		await state.waitForIdle();

		const retry = state.claimDelete('channels:retry', snapshot(state, generation, 5, 'channels'));
		assert.isDefined(retry);
		assert.isTrue(state.beginPhysicalDelete(retry!));
		assert.equal(state.completeDelete(retry!, true), 'completed');
	});

	test('a failed overlapping write hides bytes whose storage outcome is ambiguous', () => {
		const state = activeState();
		const generation = ready(state);
		const first = state.stageWrite('roles:one', state.observePacket(generation, 2));
		assert.isTrue(state.beginWrite(first));
		const second = state.stageWrite('roles:one', state.observePacket(generation, 3));
		assert.equal(state.completeWrite(first, true), 'committed');
		assert.isTrue(state.beginWrite(second));
		assert.equal(state.completeWrite(second, false), 'failed');
		assert.equal(state.visibilityOf('roles:one', generation)?.fence, second.fence);
		assert.equal(state.visibilityOf('roles:one', generation)?.state, 'unknown-preserved');
		assert.isFalse(state.canRead('roles:one', generation));
	});

	test('an atomically rejected write preserves the last proven visibility', () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'roles:one', generation, 2);
		const before = state.visibilityOf('roles:one', generation);
		const rejected = state.stageWrite('roles:one', state.observePacket(generation, 3));
		assert.isTrue(state.beginWrite(rejected));

		assert.equal(state.rejectWrite(rejected), 'failed');
		assert.equal(state.visibilityOf('roles:one', generation)?.fence, before?.fence);
		assert.equal(state.visibilityOf('roles:one', generation)?.state, 'visible');
		assert.isTrue(state.canRead('roles:one', generation));
	});

	test('an older write completion cannot replace newer visibility', () => {
		const state = activeState();
		const generation = ready(state);
		const first = state.stageWrite('roles:one', state.observePacket(generation, 2));
		assert.isTrue(state.beginWrite(first));
		const second = state.stageWrite('roles:one', state.observePacket(generation, 3));
		assert.isTrue(state.beginWrite(second));
		assert.equal(state.completeWrite(second, true), 'committed');
		assert.equal(state.completeWrite(first, true), 'superseded');
		assert.equal(state.visibilityOf('roles:one', generation)?.fence, second.fence);
	});

	test('failed physical deletion remains hidden and can be claimed by later evidence', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'emojis:one', generation, 2);
		const first = state.claimDelete('emojis:one', snapshot(state, generation, 3, 'emojis'));
		assert.isDefined(first);
		assert.isTrue(state.beginPhysicalDelete(first!));
		assert.equal(state.completeDelete(first!, false), 'failed');
		assert.equal(state.visibilityOf('emojis:one', generation)?.state, 'hidden-pending');
		await state.waitForIdle();

		const retryCut = snapshot(state, generation, 4, 'emojis');
		assert.equal(state.latestSnapshotCut(generation, { guildId: 'guild-a', resource: 'emojis' }), retryCut);
		const retry = state.claimDelete('emojis:one', retryCut);
		assert.isDefined(retry);
		assert.isTrue(state.beginPhysicalDelete(retry!));
		assert.equal(state.completeDelete(retry!, true), 'completed');
		assert.equal(state.visibilityOf('emojis:one', generation)?.state, 'hidden-pending');
	});

	test('does not replace hidden visibility while physical deletion is executing', () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'emojis:executing', generation, 2);
		const claim = state.claimDelete('emojis:executing', snapshot(state, generation, 3, 'emojis'));
		assert.isDefined(claim);
		assert.isTrue(state.beginPhysicalDelete(claim!));

		assert.isFalse(state.preserveUnknown('emojis:executing', state.observePacket(generation, 4)));
		assert.equal(state.visibilityOf('emojis:executing', generation)?.state, 'hidden-pending');
		assert.equal(state.completeDelete(claim!, true), 'completed');
		assert.equal(state.visibilityOf('emojis:executing', generation)?.state, 'hidden-pending');
	});

	test('collects retired tombstones and releases key ownership after generation replacement', () => {
		const state = activeState();
		const generation = ready(state);
		for (let index = 0; index < 25; index++) {
			const key = `roles:gc-${index}`;
			const claim = state.claimDelete(key, snapshot(state, generation, index + 2));
			assert.isDefined(claim);
			assert.isTrue(state.beginPhysicalDelete(claim!));
			assert.equal(state.completeDelete(claim!, true), 'completed');
			assert.equal(state.visibilityOf(key, generation)?.state, 'hidden-pending');
		}
		expect(() => state.stageGlobalWrite('roles:gc-0')).toThrow(/visibility scope/);

		ready(state, { sequence: 1, sessionId: 'replacement' });
		for (let index = 0; index < 25; index++) {
			const key = `roles:gc-${index}`;
			const reused = state.stageGlobalWrite(key);
			assert.isTrue(state.beginWrite(reused));
			assert.equal(state.completeWrite(reused, true), 'committed');
			assert.isTrue(state.canRead(key, GLOBAL_VISIBILITY_SCOPE));
		}
	});

	test('closing cancels a queued physical delete', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'guilds:one', generation, 2);
		const claim = state.claimDelete('guilds:one', snapshot(state, generation, 3, 'guilds'));
		assert.isDefined(claim);
		state.beginClosing();
		assert.isFalse(state.beginPhysicalDelete(claim!));
		assert.equal(state.completeDelete(claim!, false), 'stale');
		await state.waitForIdle();
		state.finishClosing();
	});

	test('closing drains a physical delete that already began', async () => {
		const state = activeState();
		const generation = ready(state);
		writeVisible(state, 'guilds:executing', generation, 2);
		const claim = state.claimDelete('guilds:executing', snapshot(state, generation, 3, 'guilds'));
		assert.isDefined(claim);
		assert.isTrue(state.beginPhysicalDelete(claim!));
		const waiting = state.waitForIdle();
		state.beginClosing();
		expect(() => state.finishClosing()).toThrow(/work is pending/);
		assert.equal(state.completeDelete(claim!, false), 'failed');
		await waiting;
		state.finishClosing();
	});

	test('purges old cuts and fences old claims and reconciliation work on READY replacement', async () => {
		const state = activeState();
		const oldGeneration = ready(state, { sessionId: 'old' });
		const oldCut = snapshot(state, oldGeneration, 2, 'channels');
		const oldClaim = state.claimDelete('channels:legacy', oldCut);
		const oldWork = state.registerWork({ generation: oldGeneration, label: 'old sweep' });
		assert.isDefined(oldClaim);
		assert.equal(state.pendingWork, 2);

		const generation = ready(state, { sequence: 1, sessionId: 'new' });
		assert.isFalse(state.beginPhysicalDelete(oldClaim!));
		assert.isFalse(state.settleWork(oldWork));
		assert.equal(state.completeDelete(oldClaim!, true), 'stale');
		assert.equal(state.latestSnapshotCut(generation, { guildId: 'guild-a', resource: 'channels' }), undefined);
		await state.waitForIdle();
	});

	test('READY replacement drains old reconciliation and deletion work that already began', async () => {
		const state = activeState();
		const oldGeneration = ready(state, { sessionId: 'old' });
		const oldClaim = state.claimDelete('channels:executing', snapshot(state, oldGeneration, 2, 'channels'));
		const oldWork = state.registerWork({ generation: oldGeneration, label: 'executing sweep' });
		assert.isDefined(oldClaim);
		assert.isTrue(state.beginPhysicalDelete(oldClaim!));
		assert.isTrue(state.beginWork(oldWork));

		ready(state, { sequence: 1, sessionId: 'new' });
		let idle = false;
		const waiting = state.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		assert.isFalse(idle);
		assert.equal(state.pendingWork, 2);
		assert.isTrue(state.settleWork(oldWork));
		await Promise.resolve();
		assert.isFalse(idle);
		assert.equal(state.completeDelete(oldClaim!, true), 'completed');
		await waiting;
	});
});

describe('ReconciliationState global visibility and snapshot policy', () => {
	test('issues a fence for direct shard writes while excluding the global scope', () => {
		const state = activeState();
		const generation = ready(state);
		expectTypeOf<Parameters<ReconciliationState['stageWrite']>[1]>().toEqualTypeOf<CausalPosition | ShardGeneration>();
		const direct = state.stageWrite('roles:direct', generation);
		assert.isAbove(direct.fence, 0);
		assert.isTrue(state.beginWrite(direct));
		assert.equal(state.completeWrite(direct, true), 'committed');
		assert.isTrue(state.canRead('roles:direct', generation));
		expect(() => state.stageWrite('users:not-shard', GLOBAL_VISIBILITY_SCOPE as unknown as ShardGeneration)).toThrow(
			/require a shard generation/,
		);
	});

	test('rejects a global Gateway write when its origin generation is replaced', () => {
		const state = activeState();
		const generation = ready(state, { sessionId: 'old' });
		const gatewayWrite = state.stageGlobalWrite('users:gateway', state.observePacket(generation, 2));
		const dmWrite = state.stageGlobalWrite('users:dm-current');
		ready(state, { sequence: 1, sessionId: 'new' });
		assert.isFalse(state.beginWrite(gatewayWrite));
		assert.isFalse(state.canRead('users:gateway', GLOBAL_VISIBILITY_SCOPE));

		assert.isTrue(state.beginWrite(dmWrite));
		assert.equal(state.completeWrite(dmWrite, true), 'committed');
		assert.isTrue(state.canRead('users:dm-current', GLOBAL_VISIBILITY_SCOPE));
	});

	test('does not let shard and global visibility scopes overwrite one another', () => {
		const state = activeState();
		const generation = ready(state);
		const globalWrite = state.stageGlobalWrite('users:owned');
		assert.isTrue(state.beginWrite(globalWrite));
		assert.equal(state.completeWrite(globalWrite, true), 'committed');
		const shardPosition = state.observePacket(generation, 2);
		assert.isFalse(state.preserveUnknown('users:owned', shardPosition));
		assert.equal(state.claimDelete('users:owned', snapshot(state, generation, 3, 'users')), undefined);
		expect(() => state.stageWrite('users:owned', state.observePacket(generation, 4))).toThrow(/visibility scope/);
		assert.isTrue(state.canRead('users:owned', GLOBAL_VISIBILITY_SCOPE));

		writeVisible(state, 'roles:owned', generation, 5);
		expect(() => state.stageGlobalWrite('roles:owned')).toThrow(/visibility scope/);
		assert.isTrue(state.canRead('roles:owned', generation));
	});

	test('users remain globally visible across shard READY generations and DM writes', () => {
		const state = activeState();
		const shardZero = ready(state, { sessionId: 'zero', shardId: 0 });
		const shardOne = ready(state, { sessionId: 'one', shardId: 1 });
		const userWrite = state.stageGlobalWrite('users:shared', state.observePacket(shardZero, 2));
		assert.isTrue(state.beginWrite(userWrite));
		assert.equal(state.completeWrite(userWrite, true), 'committed');

		ready(state, { sequence: 1, sessionId: 'zero-next', shardId: 0 });
		assert.isTrue(state.isCurrentGeneration(shardOne));
		assert.isTrue(state.canRead('users:shared', GLOBAL_VISIBILITY_SCOPE));
		assert.equal(state.claimDelete('users:shared', snapshot(state, shardOne, 2, 'users')), undefined);

		const secondShardWrite = state.stageGlobalWrite('users:shared', state.observePacket(shardOne, 3));
		assert.isTrue(state.beginWrite(secondShardWrite));
		assert.equal(state.completeWrite(secondShardWrite, true), 'committed');
		const dmWrite = state.stageGlobalWrite('users:dm');
		assert.isTrue(state.beginWrite(dmWrite));
		assert.equal(state.completeWrite(dmWrite, true), 'committed');
		assert.isTrue(state.canRead('users:dm', GLOBAL_VISIBILITY_SCOPE));
		assert.isFalse(state.canRead('users:unseen', GLOBAL_VISIBILITY_SCOPE));
		assert.isFalse(state.isCurrentGeneration(shardZero));
	});

	test('distinguishes absent optional arrays from present empty arrays', () => {
		assert.deepEqual(snapshotArrayField({ id: 'guild' }, 'stickers'), { action: 'preserve' });
		assert.deepEqual(snapshotArrayField({ stickers: [] }, 'stickers'), { action: 'replace', values: [] });
		assert.deepEqual(snapshotArrayField({ overwrites: [{ id: 'role' }] }, 'overwrites'), {
			action: 'replace',
			values: [{ id: 'role' }],
		});
		expect(() => snapshotArrayField({ stickers: null }, 'stickers')).toThrow(/must be an array/);
	});

	test('derives every resource cut in one snapshot from the exact same causal position', () => {
		const state = activeState();
		const generation = ready(state);
		const position = state.observePacket(generation, 20);
		const cuts = ['roles', 'channels', 'emojis', 'stickers', 'overwrites', 'voiceStates', 'stageInstances'].map(
			resource => state.recordSnapshot(position, { completeness: 'authoritative', guildId: 'guild-a', resource }),
		);

		for (const cut of cuts) {
			assert.equal(cut.generation, position.generation);
			assert.equal(cut.sequence, position.sequence);
			assert.equal(cut.fence, position.fence);
		}
		assert.isAbove(state.observePacket(generation, 21).fence, position.fence);
	});
});

describe('ReconciliationState handle ownership', () => {
	test('foreign handles with colliding numeric IDs cannot settle or mutate this state', async () => {
		const left = activeState();
		const right = activeState();
		const leftGeneration = ready(left);
		const rightGeneration = ready(right);
		expect(() => left.observePacket(rightGeneration, 2)).toThrow(/no longer active/);

		const leftPosition = left.observePacket(leftGeneration, 2);
		const forgedPosition = { ...leftPosition };
		expect(() => left.stageWrite('roles:forged', forgedPosition)).toThrow(/not issued/);

		const leftWork = left.registerWork({ label: 'left' });
		const rightWork = right.registerWork({ label: 'right' });
		assert.isFalse(left.beginWork(rightWork));
		assert.isTrue(left.beginWork(leftWork));
		assert.isTrue(right.beginWork(rightWork));
		assert.isFalse(left.settleWork(rightWork));
		assert.isTrue(left.settleWork(leftWork));
		assert.isTrue(right.settleWork(rightWork));

		const leftWrite = left.stageGlobalWrite('users:left');
		const rightWrite = right.stageGlobalWrite('users:right');
		assert.equal(left.completeWrite(rightWrite, true), 'superseded');
		assert.isFalse(left.beginWrite(rightWrite));
		assert.isTrue(left.beginWrite(leftWrite));
		assert.isTrue(right.beginWrite(rightWrite));
		assert.equal(left.completeWrite(leftWrite, true), 'committed');
		assert.equal(right.completeWrite(rightWrite, true), 'committed');

		const leftClaim = left.claimDelete('roles:left', snapshot(left, leftGeneration, 3));
		const rightClaim = right.claimDelete('roles:right', snapshot(right, rightGeneration, 3));
		assert.isDefined(leftClaim);
		assert.isDefined(rightClaim);
		assert.isFalse(left.beginPhysicalDelete(rightClaim!));
		assert.isTrue(left.beginPhysicalDelete(leftClaim!));
		assert.isTrue(right.beginPhysicalDelete(rightClaim!));
		assert.equal(left.completeDelete(rightClaim!, true), 'stale');
		assert.equal(left.completeDelete(leftClaim!, true), 'completed');
		assert.equal(right.completeDelete(rightClaim!, true), 'completed');
		await Promise.all([left.waitForIdle(), right.waitForIdle()]);
	});
});

describe('ReconciliationState direct removal and flush fences', () => {
	test('keeps failed removes hidden but safely collects successful direct tombstones', () => {
		const state = new ReconciliationState();
		state.activate();
		const failedWrite = state.stageGlobalWrite('failed');
		assert.isTrue(state.beginWrite(failedWrite));
		state.completeWrite(failedWrite, true);
		const failed = state.stageGlobalRemove('failed');
		assert.isTrue(state.beginRemove(failed));
		assert.equal(state.completeRemove(failed, false), 'failed');
		assert.equal(state.ownedVisibilityOf('failed')?.state, 'hidden-pending');

		const successfulWrite = state.stageGlobalWrite('successful');
		assert.isTrue(state.beginWrite(successfulWrite));
		state.completeWrite(successfulWrite, true);
		const successful = state.stageGlobalRemove('successful');
		assert.isTrue(state.beginRemove(successful));
		assert.equal(state.completeRemove(successful, true), 'completed');
		assert.equal(state.ownedVisibilityOf('successful'), undefined);

		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const position = state.observePacket(generation, 2);
		assert.isFalse(state.preserveUnknown('failed', position));
		assert.isTrue(state.preserveUnknown('successful', position));
	});

	test('does not let preserveUnknown replace an executing remove', () => {
		const state = new ReconciliationState();
		state.activate();
		const write = state.stageGlobalWrite('key');
		assert.isTrue(state.beginWrite(write));
		state.completeWrite(write, true);
		const remove = state.stageGlobalRemove('key');
		assert.isTrue(state.beginRemove(remove));
		assert.isFalse(state.preserveUnknown('key', GLOBAL_VISIBILITY_SCOPE));
		assert.equal(state.ownedVisibilityOf('key')?.state, 'hidden-pending');
		state.completeRemove(remove, false);
	});

	test('collects successfully flushed evidence after older write attempts drain', () => {
		const state = new ReconciliationState();
		state.activate();
		const initial = state.stageGlobalWrite('key');
		assert.isTrue(state.beginWrite(initial));
		state.completeWrite(initial, true);
		const olderPending = state.stageGlobalWrite('key');
		const flush = state.stageFlush();
		assert.isTrue(state.beginFlush(flush));
		assert.equal(state.completeFlush(flush, true), 'completed');
		assert.equal(state.ownedVisibilityOf('key')?.state, 'hidden-pending');
		assert.isFalse(state.beginWrite(olderPending));
		assert.equal(state.ownedVisibilityOf('key'), undefined);
	});

	test('keeps a causal global remove globally owned until its origin generation retires', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'old',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const position = state.observePacket(generation, 2);
		const write = state.stageGlobalWrite('global', position);
		assert.isTrue(state.beginWrite(write));
		state.completeWrite(write, true);
		const remove = state.stageGlobalRemove('global', position);
		assert.equal(remove.generation, GLOBAL_VISIBILITY_SCOPE);
		assert.equal(remove.origin, generation);
		assert.isTrue(state.beginRemove(remove));
		state.completeRemove(remove, true);
		assert.equal(state.ownedVisibilityOf('global')?.generation, GLOBAL_VISIBILITY_SCOPE);

		const replacement = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'new',
			shardId: 0,
		});
		state.markGuildsReady(replacement);
		assert.equal(state.ownedVisibilityOf('global'), undefined);
	});

	test('retains a direct shard remove against positions issued before deletion', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'old',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const remove = state.stageRemove('shard-key', generation);
		assert.isTrue(state.beginRemove(remove));
		assert.equal(state.completeRemove(remove, true), 'completed');

		const delayed = state.stageWrite('shard-key', oldPosition);
		assert.isFalse(state.beginWrite(delayed));
		assert.equal(state.ownedVisibilityOf('shard-key')?.state, 'hidden-pending');

		const replacement = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'new',
			shardId: 0,
		});
		state.markGuildsReady(replacement);
		assert.equal(state.ownedVisibilityOf('shard-key'), undefined);
	});

	test('retains a direct global remove against every generation active at its cut', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'old',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const remove = state.stageGlobalRemove('global-key');
		assert.isTrue(state.beginRemove(remove));
		assert.equal(state.completeRemove(remove, true), 'completed');

		const delayed = state.stageGlobalWrite('global-key', oldPosition);
		assert.isFalse(state.beginWrite(delayed));
		assert.equal(state.ownedVisibilityOf('global-key')?.state, 'hidden-pending');

		const replacement = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'new',
			shardId: 0,
		});
		state.markGuildsReady(replacement);
		assert.equal(state.ownedVisibilityOf('global-key'), undefined);
	});

	test('keeps a failed flush floor above previously issued positions for unknown keys', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const flush = state.stageFlush();
		assert.isTrue(state.beginFlush(flush));
		assert.equal(state.completeFlush(flush, false), 'failed');

		const delayed = state.stageWrite('previously-unknown', oldPosition);
		assert.isFalse(state.beginWrite(delayed));
		assert.equal(state.ownedVisibilityOf('previously-unknown'), undefined);
		assert.equal(state.pendingWork, 0);
	});

	test('rejects stale preservation before creating visibility or ownership', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const flush = state.stageFlush();
		assert.isTrue(state.beginFlush(flush));
		assert.equal(state.completeFlush(flush, false), 'failed');

		assert.isFalse(state.preserveUnknown('unseen', oldPosition));
		assert.equal(state.ownedVisibilityOf('unseen'), undefined);
		const global = state.stageGlobalWrite('unseen');
		assert.isTrue(state.beginWrite(global));
		assert.equal(state.completeWrite(global, true), 'committed');
	});

	test('releases only ownership introduced by a write rejected below the flush floor', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const flush = state.stageFlush();
		assert.isTrue(state.beginFlush(flush));
		assert.equal(state.completeFlush(flush, false), 'failed');

		const first = state.stageWrite('new-key', oldPosition);
		const second = state.stageWrite('new-key', oldPosition);
		assert.isFalse(state.beginWrite(first));
		assert.equal(state.pendingWork, 1);
		assert.isFalse(state.beginWrite(second));
		assert.equal(state.pendingWork, 0);
		assert.equal(state.ownedVisibilityOf('new-key'), undefined);
		const global = state.stageGlobalWrite('new-key');
		assert.isTrue(state.beginWrite(global));
		assert.equal(state.completeWrite(global, true), 'committed');
	});

	test('preserves preexisting ownership when a later write falls below the flush floor', () => {
		const state = new ReconciliationState();
		state.activate();
		const generation = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session',
			shardId: 0,
		});
		state.markGuildsReady(generation);
		const oldPosition = state.observePacket(generation, 2);
		const existing = state.stageWrite('owned-key', generation);
		assert.isTrue(state.beginWrite(existing));
		assert.equal(state.completeWrite(existing, true), 'committed');
		const flush = state.stageFlush();
		assert.isTrue(state.beginFlush(flush));
		assert.equal(state.completeFlush(flush, false), 'failed');
		const before = state.ownedVisibilityOf('owned-key');

		const stale = state.stageWrite('owned-key', oldPosition);
		assert.isFalse(state.beginWrite(stale));
		assert.deepEqual(state.ownedVisibilityOf('owned-key'), before);
		expect(() => state.stageGlobalWrite('owned-key')).toThrow(/different visibility scope/);
		assert.equal(state.pendingWork, 0);
	});

	test('retains a causal global remove until every generation active at its cut retires', () => {
		const state = new ReconciliationState();
		state.activate();
		const shardZero = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'zero',
			shardId: 0,
		});
		const shardOne = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'one',
			shardId: 1,
		});
		state.markGuildsReady(shardZero);
		state.markGuildsReady(shardOne);
		const shardOnePosition = state.observePacket(shardOne, 2);
		const removePosition = state.observePacket(shardZero, 2);
		const remove = state.stageGlobalRemove('shared', removePosition);
		assert.isTrue(state.beginRemove(remove));
		assert.equal(state.completeRemove(remove, true), 'completed');

		const zeroReplacement = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'zero-next',
			shardId: 0,
		});
		state.markGuildsReady(zeroReplacement);
		const delayed = state.stageGlobalWrite('shared', shardOnePosition);
		assert.isFalse(state.beginWrite(delayed));
		assert.equal(state.ownedVisibilityOf('shared')?.state, 'hidden-pending');

		const oneReplacement = state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'one-next',
			shardId: 1,
		});
		state.markGuildsReady(oneReplacement);
		assert.equal(state.ownedVisibilityOf('shared'), undefined);
	});
});
