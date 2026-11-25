import { describe, expect, it } from 'vitest';
import { isStaleChannel, planGuildSnapshot } from '../src/snapshot';
import { type KeyTarget, ReconciliationState, type SnapshotCut, shardOf } from '../src/state';
import { guildOn } from './support';

function role(guildId: string, id: string): KeyTarget {
	return { key: `role.${id}`, to: `role.${guildId}`, id, guildId, replaceable: true };
}

function member(guildId: string, id: string): KeyTarget {
	return { key: `member.${guildId}.${id}`, to: `member.${guildId}`, id, guildId, replaceable: false };
}

function user(id: string): KeyTarget {
	return { key: `user.${id}`, to: 'user', id, guildId: undefined, replaceable: false };
}

function write(state: ReconciliationState, ...targets: KeyTarget[]): void {
	state.commitWrite(state.beginWrite(targets));
}

function activeState(): ReconciliationState {
	const state = new ReconciliationState();
	state.activate();
	return state;
}

/** One shard, one session, with `guildId` opened by its startup snapshot at sequence 2. */
function reconciledGuild(guildId: string) {
	const state = activeState();
	state.ready(0, 'session-1', 1, [guildId], 1);
	const work = state.guildAvailable(0, guildId, 2, { startup: true, unavailable: false })!;
	const cut: SnapshotCut = { generation: work.generation, guildId, sequence: 2 };
	return { state, work, cut };
}

const G = guildOn(2);

describe('lifecycle', () => {
	it('admits Gateway observations only while active', () => {
		const state = new ReconciliationState();

		expect(state.lifecycle).toBe('installing');
		expect(state.ready(0, 'session-1', 1, [G], 1)).toEqual([]);
		expect(state.snapshot().shards).toEqual([]);

		state.activate();
		state.ready(0, 'session-1', 1, [G], 1);
		expect(state.snapshot().shards).toMatchObject([{ shardId: 0, generation: 1, startup: 'awaiting-guilds' }]);
	});

	it('makes failure terminal: nothing stays visible, registered work is cancelled, waiters resolve', async () => {
		const { state, work } = reconciledGuild(G);
		write(state, role(G, '1'), user('9'));
		const idle = state.whenIdle();
		const cause = new Error('adapter start failed');

		state.fail(cause);

		expect(state.lifecycle).toBe('failed');
		expect(state.snapshot().cause).toBe(cause);
		expect(work.settled).toBe('cancelled');
		expect(state.isVisible('role.1')).toBe(false);
		expect(state.isVisible('user.9')).toBe(false);
		await expect(idle).resolves.toBeUndefined();

		state.activate();
		expect(state.lifecycle).toBe('failed');
	});

	it('keeps a failed instance fail-closed while it closes', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, '1'), user('9'));
		state.fail(new Error('lease lost'));

		state.beginClose();
		expect(state.lifecycle).toBe('closing');
		expect(state.isVisible('role.1')).toBe(false);
		expect(state.isVisible('user.9')).toBe(false);

		state.close();
		expect(state.lifecycle).toBe('closed');
		expect(state.isVisible('user.9')).toBe(false);
	});

	it('fences every claim and cancels registered work when closing begins', () => {
		const { state, work, cut } = reconciledGuild(G);
		const sweep = state.claimSweep([role(G, 'stale')], cut);
		expect(sweep.keys).toEqual(['role.stale']);

		state.beginClose();

		expect(work.settled).toBe('cancelled');
		expect(state.snapshot().pending.guilds).toBe(0);
		expect(state.confirmSweep(sweep, cut)).toEqual([]);
		expect(state.claimSweep([role(G, 'other')], cut).keys).toEqual([]);
		expect(state.ready(0, 'session-2', 1, [], 1)).toEqual([]);
	});

	it('cannot be revived once closed', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [], 1);

		state.close();
		state.activate();

		expect(state.lifecycle).toBe('closed');
		expect(state.guildsReady(0)).toBeUndefined();
	});

	it('still waits for running sweeps after it stops admitting work', async () => {
		const state = activeState();
		const end = state.beginTask();
		state.beginClose();
		let drained = false;
		const idle = state.whenIdle().then(() => {
			drained = true;
		});

		await Promise.resolve();
		expect(state.snapshot()).toMatchObject({ idle: false, pending: { tasks: 1 } });
		expect(drained).toBe(false);

		end();
		await idle;
		expect(state.idle).toBe(true);
	});
});

describe('generations', () => {
	it('keeps a READY guild unreadable until its own packet arrives', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);

		// A write that lands between READY and the guild packet is older than the snapshot.
		write(state, role(G, 'early'));
		expect(state.visibility('role.early')).toBe('unknown-preserved');

		state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
		expect(state.visibility('role.early')).toBe('unknown-preserved');

		// The guild packet itself advances the generation, so its own writes are stamped at its cut.
		write(state, role(G, 'fresh'));
		expect(state.visibility('role.fresh')).toBe('visible');
	});

	it('keeps shard generations independent', () => {
		const onShard0 = guildOn(2);
		const onShard1 = guildOn(3);
		const state = activeState();
		state.ready(0, 'session-a', 2, [onShard0], 1);
		state.ready(1, 'session-b', 2, [onShard1], 1);
		const work0 = state.guildAvailable(0, onShard0, 2, { startup: true, unavailable: false })!;
		state.guildAvailable(1, onShard1, 2, { startup: true, unavailable: false });
		write(state, role(onShard0, 'a'), role(onShard1, 'b'));

		// Shard 1 reconnects with a new session; shard 0's partition and pending work are untouched.
		const cancelled = state.ready(1, 'session-c', 2, [onShard1], 1);

		expect(cancelled.map(work => work.shardId)).toEqual([1]);
		expect(work0.settled).toBeUndefined();
		expect(state.isVisible('role.a')).toBe(true);
		expect(state.isVisible('role.b')).toBe(false);
		expect(state.ownsGuild(work0.generation, onShard0)).toBe(true);
		expect(state.ownsGuild(work0.generation, onShard1)).toBe(false);
	});

	it('restarts the sequence baseline on a new READY instead of comparing sessions', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
		state.observe(0, 900);
		write(state, role(G, 'old'));
		expect(state.isVisible('role.old')).toBe(true);

		state.ready(0, 'session-2', 1, [G], 1);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;

		// Sequence 900 belongs to the previous session; it neither stays visible nor outranks the new cut.
		expect(state.visibility('role.old')).toBe('unknown-preserved');
		const claim = state.claimSweep([role(G, 'old')], { generation: work.generation, guildId: G, sequence: 2 });
		expect(claim.keys).toEqual(['role.old']);
		write(state, role(G, 'new'));
		expect(state.isVisible('role.new')).toBe(true);
	});

	it('does not let a write issued in the previous session validate or displace anything in the new one', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
		const late = state.beginWrite([role(G, 'only-old'), role(G, 'rewritten')]);

		state.ready(0, 'session-2', 1, [G], 1);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;
		state.observe(0, 5);
		write(state, role(G, 'rewritten'));
		state.commitWrite(late);

		expect(state.visibility('role.only-old')).toBe('unknown-preserved');
		// The newer record keeps its own position: the late commit did not drag it back before the cut.
		expect(state.isVisible('role.rewritten')).toBe(true);
		const cut = { generation: work.generation, guildId: G, sequence: 2 };
		expect(state.claimSweep([role(G, 'rewritten')], cut).keys).toEqual([]);
	});

	it('continues the generation on RESUMED only when this instance already holds it', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		state.guildAvailable(0, G, 2, { startup: true, unavailable: false });
		write(state, role(G, '1'));

		expect(state.resumed(0)).toBe(true);
		state.observe(0, 3);

		expect(state.isVisible('role.1')).toBe(true);
		expect(state.snapshot().shards).toMatchObject([{ generation: 1, sessionId: 'session-1' }]);
	});

	it('fails closed on RESUMED without a validated generation until a new READY', () => {
		const state = activeState();
		write(state, role(G, 'unscoped'), user('9'));
		expect(state.isVisible('role.unscoped')).toBe(true);

		expect(state.resumed(0)).toBe(false);

		expect(state.snapshot().shards).toEqual([expect.objectContaining({ shardId: 0, startup: 'awaiting-ready' })]);
		expect(state.isVisible('role.unscoped')).toBe(false);
		expect(state.guildAvailable(0, G, 4, { startup: true, unavailable: false })).toBeUndefined();
		expect(state.isVisible('user.9')).toBe(true);

		state.ready(0, 'session-2', 1, [G], 1);
		expect(state.snapshot().shards).toMatchObject([{ generation: 1, startup: 'awaiting-guilds' }]);
	});

	it('fails a shard closed once its cache stopped following the Gateway', () => {
		const other = guildOn(3);
		const state = activeState();
		state.ready(0, 'session-a', 2, [G], 1);
		state.ready(1, 'session-b', 2, [other], 1);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;
		const otherWork = state.guildAvailable(1, other, 2, { startup: true, unavailable: false })!;
		write(state, role(G, '1'), role(other, '2'));

		expect(state.suspend(0)).toBe(true);
		expect(state.suspend(0)).toBe(false);

		expect(work.settled).toBe('cancelled');
		expect(otherWork.settled).toBeUndefined();
		expect(state.isVisible('role.1')).toBe(false);
		expect(state.isVisible('role.2')).toBe(true);
		expect(state.snapshot().shards).toMatchObject([
			{ shardId: 0, generation: undefined, startup: 'awaiting-ready' },
			{ shardId: 1, startup: 'awaiting-guilds' },
		]);
		// Only a new READY brings the shard back, and it has to suspend again if the cache is still not followed.
		state.ready(0, 'session-c', 2, [G], 1);
		expect(state.suspend(0)).toBe(true);
	});

	it('treats a guild no generation owns as unscoped', () => {
		const foreign = guildOn(3);
		const state = activeState();
		state.ready(0, 'session-1', 2, [], 1);

		write(state, role(foreign, '1'));

		expect(state.isVisible('role.1')).toBe(true);
	});

	it('never moves a generation backwards when packets are observed out of order', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		state.observe(0, 10);
		state.observe(0, 4);
		const work = state.guildAvailable(0, G, 6, { startup: true, unavailable: false })!;

		write(state, role(G, 'after-ten'));

		const cut = { generation: work.generation, guildId: G, sequence: 6 };
		expect(state.claimSweep([role(G, 'after-ten')], cut).keys).toEqual([]);
	});
});

describe('startup barrier', () => {
	it('does not commit when GUILDS_READY overtakes the last guild packet', () => {
		const first = guildOn(2);
		const last = guildOn(4);
		const state = activeState();
		state.ready(0, 'session-1', 1, [first, last], 1);
		const firstWork = state.guildAvailable(0, first, 2, { startup: true, unavailable: false })!;

		expect(state.settle(firstWork, 'reconciled')).toBeUndefined();
		// The stream ended, but the last guild has not even registered its work yet.
		expect(state.guildsReady(0)).toBeUndefined();
		expect(state.snapshot()).toMatchObject({ idle: false, pending: { guilds: 0 } });

		const lastWork = state.guildAvailable(0, last, 3, { startup: true, unavailable: false })!;
		expect(state.snapshot().shards[0]).toMatchObject({ startup: 'awaiting-guilds', settledGuilds: 1 });

		expect(state.settle(lastWork, 'reconciled')).toBe(lastWork.generation);
		expect(state.snapshot()).toMatchObject({
			idle: true,
			shards: [{ startup: 'committed', expectedGuilds: 2, settledGuilds: 2, outcomes: { reconciled: 2 } }],
		});
	});

	it('does not commit before GUILDS_READY even when every guild already settled', () => {
		const { state, work } = reconciledGuild(G);

		expect(state.settle(work, 'reconciled')).toBeUndefined();
		expect(state.snapshot()).toMatchObject({ idle: false, shards: [{ startup: 'awaiting-guilds', settledGuilds: 1 }] });

		expect(state.guildsReady(0)).toBe(work.generation);
		expect(state.guildsReady(0)).toBeUndefined();
	});

	it('commits a zero-guild READY at GUILDS_READY without manufacturing work', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [], 1);
		expect(state.idle).toBe(false);

		expect(state.guildsReady(0)).toBe(1);

		expect(state.snapshot()).toMatchObject({ idle: true, pending: { guilds: 0, tasks: 0 } });
	});

	it('gives each registration exactly one terminal outcome', () => {
		const { state, work } = reconciledGuild(G);
		state.guildsReady(0);

		expect(state.settle(work, 'failed')).toBe(work.generation);
		expect(state.settle(work, 'reconciled')).toBeUndefined();

		expect(work.settled).toBe('failed');
		expect(state.snapshot().shards[0]!.outcomes).toMatchObject({ failed: 1, reconciled: 0 });
	});

	it('records an unavailable startup guild as preserved, not removed', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		state.guildAvailable(0, G, 1, { startup: true, unavailable: false });
		write(state, member(G, 'legacy'));
		state.ready(0, 'session-2', 1, [G], 1);

		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: true })!;
		state.guildsReady(0);

		expect(work.kind).toBe('unavailable');
		expect(state.settle(work, 'unavailable-preserved')).toBe(work.generation);
		// Descendants from the previous session stay hidden, and nothing may claim the guild.
		expect(state.visibility(`member.${G}.legacy`)).toBe('unknown-preserved');
		expect(state.claimGuild(work.generation, G)).toBeUndefined();
		// A write after the outage notice is current evidence.
		write(state, role(G, 'after'));
		expect(state.isVisible('role.after')).toBe(true);
	});

	it('keeps the guild on an unavailable startup delete and opens it for later evidence', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);

		const work = state.guildGone(0, G, 2, { startup: true, unavailable: true })!;
		state.guildsReady(0);

		expect(work.kind).toBe('unavailable');
		expect(state.settle(work, 'unavailable-preserved')).toBe(work.generation);
		expect(state.snapshot().shards[0]!.outcomes).toMatchObject({ 'unavailable-preserved': 1, deleted: 0 });
		expect(state.claimGuild(work.generation, G)).toBeUndefined();
		write(state, role(G, 'after-outage'));
		expect(state.isVisible('role.after-outage')).toBe(true);
	});

	it('ignores an outage outside startup: the guild and its descendants stay readable', () => {
		const { state, work } = reconciledGuild(G);
		write(state, role(G, '1'));

		expect(state.guildGone(0, G, 9, { startup: false, unavailable: true })).toBeUndefined();

		expect(state.isVisible('role.1')).toBe(true);
		expect(state.claimGuild(work.generation, G)).toBeUndefined();
	});

	it('registers cleanup for a real removal and records the startup outcome', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);

		const work = state.guildGone(0, G, 3, { startup: true, unavailable: false })!;
		state.guildsReady(0);

		expect(work.kind).toBe('delete');
		expect(state.settle(work, 'deleted')).toBe(work.generation);
		expect(state.snapshot().shards[0]!.outcomes).toMatchObject({ deleted: 1 });
	});

	it('cancels the previous session work when a new READY arrives', () => {
		const { state, work } = reconciledGuild(G);

		const cancelled = state.ready(0, 'session-2', 1, [G], 1);

		expect(cancelled).toEqual([work]);
		expect(work.settled).toBe('cancelled');
		expect(state.settle(work, 'reconciled')).toBeUndefined();
		expect(state.snapshot().shards[0]).toMatchObject({ generation: 2, settledGuilds: 0 });
	});

	it('waits for running sweeps before reporting idle', async () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [], 1);
		const end = state.beginTask();
		state.guildsReady(0);
		let resolved = false;
		const idle = state.whenIdle().then(() => {
			resolved = true;
		});

		await Promise.resolve();
		expect(resolved).toBe(false);

		end();
		end();
		await idle;
		expect(state.snapshot().pending.tasks).toBe(0);
	});
});

describe('visibility states', () => {
	it('separates what may be read from what may be deleted', () => {
		const { state, cut } = reconciledGuild(G);
		write(state, role(G, 'current'));
		const claim = state.claimSweep([role(G, 'ghost')], cut);

		expect(state.visibility('role.current')).toBe('visible');
		expect(state.visibility(`member.${G}.legacy`)).toBe('unknown-preserved');
		expect(state.visibility('role.ghost')).toBe('hidden-pending');

		expect(state.isVisible('role.current')).toBe(true);
		expect(state.isVisible(`member.${G}.legacy`)).toBe(false);
		expect(state.isVisible('role.ghost')).toBe(false);
		expect(state.confirmSweep(claim, cut)).toEqual(['role.ghost']);
		expect(state.snapshot().pending.deletions).toBe(1);
	});

	it('never lets a snapshot claim what it is not authoritative for', () => {
		const other = guildOn(4);
		const state = activeState();
		state.ready(0, 'session-1', 1, [G, other], 1);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;
		state.guildAvailable(0, other, 3, { startup: true, unavailable: false });
		write(state, user('9'));
		const cut = { generation: work.generation, guildId: G, sequence: 2 };

		const claim = state.claimSweep([member(G, 'legacy'), role(other, 'legacy'), user('9'), role(G, 'ghost')], cut);

		// Members are a partial list, the other guild has its own snapshot, and no shard owns a user.
		expect(claim.keys).toEqual(['role.ghost']);
		expect(state.visibility(`member.${G}.legacy`)).toBe('unknown-preserved');
		expect(state.visibility('role.legacy')).toBe('unknown-preserved');
		expect(state.isVisible('user.9')).toBe(true);
	});

	it('keeps a user visible across the generations of every shard', () => {
		const onShard0 = guildOn(2);
		const onShard1 = guildOn(3);
		const state = activeState();
		state.ready(0, 'session-a', 2, [onShard0], 1);
		state.ready(1, 'session-b', 2, [onShard1], 1);
		write(state, user('seen-on-0'));

		state.ready(1, 'session-c', 2, [onShard1], 1);
		state.ready(0, 'session-d', 2, [onShard0], 1);

		expect(state.isVisible('user.seen-on-0')).toBe(true);
	});

	it('validates a user from a write that belongs to no guild', () => {
		const state = activeState();
		expect(state.visibility('user.dm')).toBe('unknown-preserved');

		write(state, user('dm'));

		expect(state.isVisible('user.dm')).toBe(true);
		expect(state.visibleMember('user', 'dm')).toBe('user.dm');
	});

	it('hides a key before its removal and forgets it only when the removal succeeds', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'a'), role(G, 'b'));

		const failed = state.beginRemoval(['role.a']);
		expect(state.visibility('role.a')).toBe('hidden-pending');
		expect(state.visibleMember(`role.${G}`, 'a')).toBeUndefined();
		state.abandonRemoval(failed);
		expect(state.visibility('role.a')).toBe('hidden-pending');
		expect(state.snapshot().pending.deletions).toBe(1);

		const succeeded = state.beginRemoval(['role.b']);
		state.commitRemoval(succeeded);
		expect(state.visibility('role.b')).toBe('unknown-preserved');
		expect(state.relationshipKeys(`role.${G}`)).toEqual(['role.a']);
	});

	it('accounts for a failed removal of a key it never filed', () => {
		const state = activeState();

		const claim = state.beginRemoval(['role.legacy']);
		state.abandonRemoval(claim);

		expect(state.visibility('role.legacy')).toBe('hidden-pending');
		expect(state.snapshot().pending.deletions).toBe(1);
	});

	it('does not let an outdated claim forget a key another removal hid again', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'a'));
		const first = state.beginRemoval(['role.a']);
		const second = state.beginRemoval(['role.a']);

		state.commitRemoval(first);

		expect(state.visibility('role.a')).toBe('hidden-pending');
		state.commitRemoval(second);
		expect(state.visibility('role.a')).toBe('unknown-preserved');
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('lets a later reconciliation claim a key whose cleanup failed', () => {
		const { state, cut } = reconciledGuild(G);
		const first = state.claimSweep([role(G, 'ghost')], cut);
		expect(state.claimSweep([role(G, 'ghost')], cut).keys).toEqual([]);

		state.abandonRemoval(first);
		const retry = state.claimSweep([role(G, 'ghost')], cut);

		expect(retry.keys).toEqual(['role.ghost']);
		state.commitRemoval(retry);
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('drops every record on flush', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'a'), user('1'));
		state.beginRemoval(['role.a']);

		state.forgetAll();

		expect(state.isVisible('user.1')).toBe(false);
		expect(state.relationshipKeys('user')).toEqual([]);
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('matches relationship patterns for wildcard removals', () => {
		const other = guildOn(4);
		const state = activeState();
		write(state, role(G, 'a'), role(other, 'b'), member(G, 'm'));

		expect(state.relationshipKeys('role.*').sort()).toEqual(['role.a', 'role.b']);
		expect(state.relationshipKeys(`role.${G}`)).toEqual(['role.a']);
		expect(state.relationshipKeys('role')).toEqual([]);
	});
});

describe('writes against removals', () => {
	it('does not bring back a key when a write issued before its delete lands afterwards', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'x'));
		state.observe(0, 8);
		const update = state.beginWrite([role(G, 'x')]);
		state.observe(0, 10);
		const removal = state.beginRemoval(['role.x']);
		state.commitRemoval(removal);

		state.commitWrite(update);

		expect(state.visibility('role.x')).toBe('unknown-preserved');
		expect(state.snapshot().pending.deletions).toBe(0);
		// The tombstone only lives as long as the write it guards against.
		expect(state.relationshipKeys(`role.${G}`)).toEqual([]);
		write(state, role(G, 'x'));
		expect(state.isVisible('role.x')).toBe(true);
	});

	it('keeps the delete evidence when the removal fails and an older write lands', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'x'));
		const update = state.beginWrite([role(G, 'x')]);
		const removal = state.beginRemoval(['role.x']);

		state.commitWrite(update);
		state.abandonRemoval(removal);

		expect(state.visibility('role.x')).toBe('hidden-pending');
		expect(state.snapshot().pending.deletions).toBe(1);
	});

	it('makes a key visible again when it is written after its removal', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'x'));

		// Seyfert replaces a guild's emojis by removing the cached ones and setting the new list.
		state.commitRemoval(state.beginRemoval(['role.x']));
		write(state, role(G, 'x'));

		expect(state.isVisible('role.x')).toBe(true);
	});

	it('lets a write issued during a removal win once both finish', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'x'));
		const removal = state.beginRemoval(['role.x']);
		const recreate = state.beginWrite([role(G, 'x')]);

		state.commitRemoval(removal);
		expect(state.isVisible('role.x')).toBe(false);
		state.commitWrite(recreate);

		expect(state.isVisible('role.x')).toBe(true);
	});
});

describe('sequence fence', () => {
	it('lets a later write win when it completes before the older sweep claims', () => {
		const { state, cut } = reconciledGuild(G);
		state.observe(0, 3);
		write(state, role(G, 'created-later'));

		const claim = state.claimSweep([role(G, 'created-later')], cut);

		expect(claim.keys).toEqual([]);
		expect(state.isVisible('role.created-later')).toBe(true);
	});

	it('lets a later write win when it completes after the older sweep claimed', () => {
		const { state, cut } = reconciledGuild(G);
		const claim = state.claimSweep([role(G, 'recreated')], cut);
		expect(state.visibility('role.recreated')).toBe('hidden-pending');

		state.observe(0, 3);
		const attempt = state.beginWrite([role(G, 'recreated')]);
		// The destructive boundary sees the write in flight and stands down.
		expect(state.confirmSweep(claim, cut)).toEqual([]);
		state.commitWrite(attempt);

		expect(state.isVisible('role.recreated')).toBe(true);
		expect(state.confirmSweep(claim, cut)).toEqual([]);
		// A removal that was already issued cannot erase the newer record either.
		state.commitRemoval(claim);
		expect(state.isVisible('role.recreated')).toBe(true);
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('does not claim a key while a write to it is in flight', () => {
		const { state, cut } = reconciledGuild(G);
		const attempt = state.beginWrite([role(G, 'busy')]);

		expect(state.claimSweep([role(G, 'busy')], cut).keys).toEqual([]);

		state.failWrite(attempt);
		expect(state.claimSweep([role(G, 'busy')], cut).keys).toEqual(['role.busy']);
	});

	it('lets the snapshot win over a write stamped at or before its cut', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		const early = state.beginWrite([role(G, 'early')]);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;
		const cut = { generation: work.generation, guildId: G, sequence: 2 };
		state.commitWrite(early);
		write(state, role(G, 'at-cut'));

		const claim = state.claimSweep([role(G, 'early'), role(G, 'at-cut')], cut);

		expect(claim.keys).toEqual(['role.early', 'role.at-cut']);
	});

	it('keeps the latest position when an earlier write of the same key commits last', () => {
		const { state, cut } = reconciledGuild(G);
		const stampedAtCut = state.beginWrite([role(G, 'x')]);
		state.observe(0, 9);
		write(state, role(G, 'x'));

		state.commitWrite(stampedAtCut);

		expect(state.claimSweep([role(G, 'x')], cut).keys).toEqual([]);
	});

	it('leaves visibility untouched when a write fails', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, 'kept'));
		state.observe(0, 3);

		state.failWrite(state.beginWrite([role(G, 'kept'), role(G, 'never')]));

		expect(state.isVisible('role.kept')).toBe(true);
		expect(state.visibility('role.never')).toBe('unknown-preserved');
	});

	it('refuses a snapshot claim once the guild was reobserved or a newer READY arrived', () => {
		const { state, cut } = reconciledGuild(G);
		state.closeGuild(G);
		state.guildAvailable(0, G, 8, { startup: false, unavailable: false });
		expect(state.claimSweep([role(G, 'ghost')], cut).keys).toEqual([]);

		const next = reconciledGuild(G);
		const claim = next.state.claimSweep([role(G, 'ghost')], next.cut);
		next.state.ready(0, 'session-2', 1, [G], 1);
		expect(next.state.confirmSweep(claim, next.cut)).toEqual([]);
	});

	it('does not reopen a known guild at a later GUILD_CREATE', () => {
		const { state } = reconciledGuild(G);
		write(state, member(G, 'kept'));

		expect(state.guildAvailable(0, G, 40, { startup: false, unavailable: false })).toBeUndefined();

		expect(state.isVisible(`member.${G}.kept`)).toBe(true);
	});
});

describe('guild claims', () => {
	it('claims a guild the committed startup snapshot never listed', () => {
		const stale = guildOn(4);
		const { state, work } = reconciledGuild(G);

		// Nothing is stale until the startup snapshot is complete.
		expect(state.claimGuild(work.generation, stale)).toBeUndefined();
		state.settle(work, 'reconciled');
		state.guildsReady(0);

		const claim = state.claimGuild(work.generation, stale)!;
		expect(state.guildClaimHolds(claim)).toBe(true);
		expect(state.knownGuilds(work.generation)).toEqual(new Set([G]));
	});

	it('refuses a READY guild whose packet has not arrived', () => {
		const pending = guildOn(4);
		const state = activeState();
		state.ready(0, 'session-1', 1, [G, pending], 1);
		const work = state.guildAvailable(0, G, 2, { startup: true, unavailable: false })!;

		expect(state.claimGuild(work.generation, pending)).toBeUndefined();
		expect(state.claimGuild(work.generation, G)).toBeUndefined();
	});

	it('refuses a guild another shard owns and a READY guild the startup already cleaned up', () => {
		const removed = guildOn(4);
		const foreign = guildOn(3);
		const state = activeState();
		state.ready(0, 'session-1', 2, [removed], 1);
		const work = state.guildGone(0, removed, 2, { startup: true, unavailable: false })!;
		state.settle(work, 'deleted');
		expect(state.guildsReady(0)).toBe(work.generation);

		expect(state.claimGuild(work.generation, foreign)).toBeUndefined();
		// The READY list is what the stale-guild set is measured against; its guilds are never "stale".
		expect(state.claimGuild(work.generation, removed)).toBeUndefined();
		expect(state.claimGuild(work.generation, guildOn(6))).toBeDefined();
	});

	it('claims the guild a registered delete removed, before the startup snapshot commits', () => {
		const state = activeState();
		state.ready(0, 'session-1', 1, [G], 1);
		const work = state.guildGone(0, G, 2, { startup: true, unavailable: false })!;

		const claim = state.claimGuild(work.generation, G, work)!;

		expect(state.guildClaimHolds(claim)).toBe(true);
		expect(state.claimGuild(work.generation, guildOn(4), work)).toBeUndefined();
	});

	it('drops a guild claim when the guild is reobserved, a newer READY arrives, or closing begins', () => {
		const stale = guildOn(4);
		const { state, work } = reconciledGuild(G);
		state.settle(work, 'reconciled');
		state.guildsReady(0);

		const reobserved = state.claimGuild(work.generation, stale)!;
		state.guildAvailable(0, stale, 5, { startup: false, unavailable: false });
		expect(state.guildClaimHolds(reobserved)).toBe(false);

		state.closeGuild(stale);
		const superseded = state.claimGuild(work.generation, stale)!;
		state.ready(0, 'session-2', 1, [], 1);
		expect(state.guildClaimHolds(superseded)).toBe(false);

		state.guildsReady(0);
		const closing = state.claimGuild(2, stale)!;
		state.beginClose();
		expect(state.guildClaimHolds(closing)).toBe(false);
	});
});

describe('closing a removed guild', () => {
	it('closes the partition for a removal that is the latest evidence', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, '1'));

		state.closeGuild(G);

		expect(state.isVisible('role.1')).toBe(false);
	});

	it('keeps a guild open when it was reported as available after the delete that removes it', () => {
		const { state } = reconciledGuild(G);
		const removal = state.guildGone(0, G, 10, { startup: false, unavailable: false })!;
		// The bot joined again before the delete finished being applied.
		state.guildAvailable(0, G, 11, { startup: false, unavailable: false });
		write(state, role(G, 'after-rejoin'));

		// Removing the guild record while that delete is being applied belongs to the delete.
		state.closeGuild(G);
		state.closeGuild(G, removal.sequence);

		expect(state.isVisible('role.after-rejoin')).toBe(true);
		expect(state.claimGuild(removal.generation, G, removal)).toBeUndefined();
	});

	it('closes a guild whose delete is the newest evidence about it', () => {
		const { state } = reconciledGuild(G);
		write(state, role(G, '1'));
		const removal = state.guildGone(0, G, 10, { startup: false, unavailable: false })!;
		state.observe(0, 12);

		state.closeGuild(G, removal.sequence);

		expect(state.isVisible('role.1')).toBe(false);
		expect(state.claimGuild(removal.generation, G, removal)).toBeDefined();
	});
});

describe('failure log', () => {
	it('keeps a bounded tail and the total count', () => {
		const state = activeState();

		for (let index = 0; index < 60; index++) state.recordFailure({ kind: 'removal', message: `failure ${index}` });

		const snapshot = state.snapshot();
		expect(snapshot.failureCount).toBe(60);
		expect(snapshot.failures).toHaveLength(50);
		expect(snapshot.failures.at(-1)!.message).toBe('failure 59');
	});
});

describe('shardOf', () => {
	it('applies Discord shard formula and rejects non-snowflakes', () => {
		expect(shardOf(guildOn(5), 4)).toBe(1);
		expect(shardOf('@me', 4)).toBeUndefined();
	});
});

describe('guild snapshot plan', () => {
	it('distinguishes an absent field from a present empty array', () => {
		const plan = planGuildSnapshot(G, { id: G, roles: [{ id: '1' }], emojis: [], voice_states: [] });

		expect(plan.roles).toEqual(new Set(['1']));
		expect(plan.emojis).toEqual(new Set());
		expect(plan.voiceStates).toEqual(new Set());
		expect(plan.stickers).toBeUndefined();
		expect(plan.channels).toBeUndefined();
		expect(plan.overwrites).toBeUndefined();
		expect(plan.stageInstances).toBeUndefined();
	});

	it('drops the overwrites of a channel listed with an empty array and keeps the rest', () => {
		const plan = planGuildSnapshot(G, {
			id: G,
			channels: [
				{ id: 'with', type: 0, permission_overwrites: [{ id: 'r', type: 0, allow: '0', deny: '0' }] },
				{ id: 'emptied', type: 0, permission_overwrites: [] },
				{ id: 'field-absent', type: 0 },
			],
		});

		expect(plan.channels).toEqual(new Set(['with', 'emptied', 'field-absent']));
		// The overwrite value is an array: `[]` replaces the cached one, an absent field says nothing.
		expect(plan.overwrites).toEqual(new Set(['with', 'field-absent']));
	});

	it('keys voice states by user and stage instances by channel', () => {
		const plan = planGuildSnapshot(G, {
			id: G,
			voice_states: [{ user_id: 'u1', channel_id: 'c1' }],
			stage_instances: [{ id: 's1', channel_id: 'c2' }],
		});

		expect(plan.voiceStates).toEqual(new Set(['u1']));
		expect(plan.stageInstances).toEqual(new Set(['c2']));
	});

	it('replaces channels by type and preserves threads the snapshot cannot speak for', () => {
		const plan = planGuildSnapshot(G, {
			id: G,
			channels: [{ id: 'text', type: 0 }],
			threads: [{ id: 'active', type: 11 }],
		});

		expect(isStaleChannel(plan, 'text', { type: 0 })).toBe(false);
		expect(isStaleChannel(plan, 'active', { type: 11, thread_metadata: { archived: false } })).toBe(false);
		expect(isStaleChannel(plan, 'deleted-text', { type: 0 })).toBe(true);
		expect(isStaleChannel(plan, 'gone-thread', { type: 11, thread_metadata: { archived: false } })).toBe(true);
		expect(isStaleChannel(plan, 'archived-thread', { type: 12, thread_metadata: { archived: true } })).toBe(false);
		expect(isStaleChannel(plan, 'thread-without-metadata', { type: 10 })).toBe(false);
		expect(isStaleChannel(plan, 'untyped', { name: 'legacy' })).toBe(false);
	});

	it('does not judge a channel kind whose list was absent', () => {
		const onlyThreads = planGuildSnapshot(G, { id: G, threads: [] });
		const onlyChannels = planGuildSnapshot(G, { id: G, channels: [] });

		expect(isStaleChannel(onlyThreads, 'text', { type: 0 })).toBe(false);
		expect(isStaleChannel(onlyThreads, 'thread', { type: 11, thread_metadata: { archived: false } })).toBe(true);
		expect(isStaleChannel(onlyChannels, 'text', { type: 0 })).toBe(true);
		expect(isStaleChannel(onlyChannels, 'thread', { type: 11, thread_metadata: { archived: false } })).toBe(false);
	});
});
