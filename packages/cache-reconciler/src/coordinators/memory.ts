import type { Adapter, AdapterEntry, AdapterIncrementOptions } from 'seyfert';
import {
	type CacheReconcilerCoordinator,
	type CoordinatorBinding,
	type CoordinatorHost,
	ReconciliationCancelled,
	type RelationshipMember,
	type SweepResult,
	type WriteMethod,
} from '../coordinator';
import type { KeyLayout } from '../keys';
import type { GuildClaim, KeyTarget, ReconciliationState, RemovalClaim, SnapshotCut } from '../state';
import { type Awaitable, isThenable, like, map, settle } from '../sync';

/** Candidates are removed in groups so the fence is rechecked between them. */
const SWEEP_CHUNK = 100;

/**
 * Coordinates reconciliation inside one process.
 *
 * Visibility and causal state live in memory and every mutation is delegated to the wrapped adapter, so it
 * fences only the writers that share this process. It assumes two single-key mutations of the same key reach
 * the store in the order the adapter was asked for them.
 */
export function memoryCoordinator(): CacheReconcilerCoordinator {
	return {
		kind: 'memory',
		bind: host => new MemoryBinding(host),
	};
}

class MemoryBinding implements CoordinatorBinding {
	private readonly inner: Adapter;
	private readonly state: ReconciliationState;
	private readonly layout: KeyLayout;

	constructor(private readonly host: CoordinatorHost) {
		this.inner = host.inner;
		this.state = host.state;
		this.layout = host.layout;
	}

	start(): void {}

	close(): void {}

	publish(): void {}

	visibleKeys(keys: readonly string[]): string[] {
		return keys.filter(key => this.state.isVisible(key));
	}

	visibleMembers(to: string): Awaitable<RelationshipMember[]> {
		return map(this.inner.getToRelationship(to), ids => {
			const members: RelationshipMember[] = [];
			for (const id of ids) {
				const key = this.state.visibleMember(to, id);
				if (key !== undefined) members.push({ id, key });
			}
			return members;
		});
	}

	containsMember(to: string, id: string): Awaitable<boolean> {
		if (this.state.visibleMember(to, id) === undefined) return like(this.inner, false);
		return this.inner.contains(to, id);
	}

	write(method: WriteMethod, entries: AdapterEntry[]): Awaitable<void> {
		// One caller write may run as two store calls, so its failure is reported for the write as a whole.
		return settle(
			() => this.apply(method, entries),
			() => undefined,
			cause =>
				this.host.mutationFailed?.(
					entries.map(([key]) => key),
					cause,
				),
		);
	}

	private apply(method: WriteMethod, entries: AdapterEntry[]): Awaitable<void> {
		if (method === 'set') return this.writing(entries, () => this.inner.set(...entries[0]!));
		if (method === 'bulkSet') return this.writing(entries, () => this.inner.bulkSet(entries));
		// Patching a cache miss must not merge into whatever the store still holds for the key, so an entry the
		// caller cannot read is replaced instead.
		const merged: AdapterEntry[] = [];
		const replaced: AdapterEntry[] = [];
		for (const entry of entries) {
			const mergeable = !this.layout.manages(entry[0]) || this.state.canPatch(entry[0]);
			(mergeable ? merged : replaced).push(entry);
		}
		if (!replaced.length) {
			return this.writing(entries, () =>
				method === 'patch' ? this.inner.patch(...entries[0]!) : this.inner.bulkPatch(entries),
			);
		}
		if (method === 'patch') return this.writing(replaced, () => this.inner.set(...replaced[0]!));
		const replacing = this.writing(replaced, () => this.inner.bulkSet(replaced));
		if (!merged.length) return replacing;
		return map(replacing, () => this.writing(merged, () => this.inner.bulkPatch(merged)));
	}

	increment(
		key: string,
		field: string,
		delta: number,
		options?: AdapterIncrementOptions,
	): Awaitable<number | undefined> {
		// An entry that is not readable does not exist for the caller, and the contract returns undefined for those.
		if (this.layout.manages(key) && !this.state.isVisible(key)) return like(this.inner, undefined);
		return this.inner.increment!(key, field, delta, options);
	}

	remove(method: 'remove' | 'bulkRemove', keys: string[], claim?: GuildClaim): Awaitable<void> {
		return this.removing(keys, claim, () =>
			method === 'remove' ? this.inner.remove(keys[0]!) : this.inner.bulkRemove(keys),
		);
	}

	removeMembers(to: string, ids: string[], claim?: GuildClaim): Awaitable<void> {
		const keys: string[] = [];
		for (const id of ids) {
			const key = this.state.memberKey(to, id);
			if (key !== undefined) keys.push(key);
		}
		return this.removing(keys, claim, () => this.inner.removeToRelationship(to, ids));
	}

	removeRelationships(relationships: string[], claim?: GuildClaim): Awaitable<void> {
		const keys = relationships.flatMap(to => this.state.relationshipKeys(to));
		return this.removing(keys, claim, () => this.inner.removeRelationship(relationships));
	}

	flush(): Awaitable<void> {
		// Nothing written before a flush may be read again, whether or not the flush completes.
		this.state.forgetAll();
		return settle(
			() => this.inner.flush(),
			() => undefined,
			cause => this.state.recordFailure({ kind: 'removal', message: 'flush failed; every entry stays hidden.', cause }),
		);
	}

	closeGuild(guildId: string, upTo: number): void {
		this.state.closeGuild(guildId, upTo);
	}

	sweep(targets: readonly KeyTarget[], cut: SnapshotCut): Awaitable<SweepResult> {
		const claim = this.state.claimSweep(targets, cut);
		const result: SweepResult = { removed: [], failed: [] };
		const from = (offset: number): Awaitable<SweepResult> => {
			if (offset >= claim.keys.length) return like(this.inner, result);
			const chunk = { order: claim.order, keys: claim.keys.slice(offset, offset + SWEEP_CHUNK) };
			return map(this.removeClaimed(chunk, cut, result), () => from(offset + SWEEP_CHUNK));
		};
		return from(0);
	}

	/**
	 * The destructive boundary: the fence is rechecked right before the removals are issued, and each key is
	 * removed on its own so a write issued afterwards is never queued behind an older removal.
	 */
	private removeClaimed(chunk: RemovalClaim, cut: SnapshotCut, result: SweepResult): Awaitable<void> {
		const removed = (key: string) => {
			this.state.commitRemoval({ order: chunk.order, keys: [key] });
			result.removed.push(key);
		};
		const failed = (key: string, cause: unknown) => {
			this.removalFailed({ order: chunk.order, keys: [key] }, cause);
			result.failed.push(key);
		};
		const pending: PromiseLike<void>[] = [];
		const confirmed = this.state.confirmSweep(chunk, cut);
		// Whatever the fence no longer allows goes back unowned, so a later reconciliation may claim it.
		this.state.abandonRemoval({ order: chunk.order, keys: chunk.keys.filter(key => !confirmed.includes(key)) });
		for (const key of confirmed) {
			try {
				const removing = this.inner.remove(key);
				if (isThenable<void>(removing)) {
					pending.push(
						Promise.resolve(removing).then(
							() => removed(key),
							cause => failed(key, cause),
						),
					);
				} else removed(key);
			} catch (cause) {
				failed(key, cause);
			}
		}
		if (pending.length) return Promise.all(pending).then(() => undefined);
	}

	/** Stamps the entries, runs the write, and confirms them only when it succeeded. */
	private writing(entries: AdapterEntry[], run: () => Awaitable<void>): Awaitable<void> {
		const targets: KeyTarget[] = [];
		for (const [key, , relationship] of entries) {
			const target = this.layout.target(key, relationship);
			if (!target) continue;
			const channel = this.layout.messageChannel(target.to);
			targets.push(channel === undefined ? target : { ...target, guildId: this.state.guildOf(channel) });
		}
		const attempt = this.state.beginWrite(targets);
		return settle(
			run,
			() => this.state.commitWrite(attempt),
			cause => {
				this.state.failWrite(attempt);
				this.state.recordFailure({
					kind: 'write',
					message: 'A cache write failed; the affected keys keep their previous visibility.',
					key: targets[0]?.key,
					cause,
				});
			},
		);
	}

	/** Hides the keys, runs the removal, and keeps them hidden when it fails. */
	private removing(keys: string[], claim: GuildClaim | undefined, run: () => Awaitable<void>): Awaitable<void> {
		if (claim && !this.state.guildClaimHolds(claim)) {
			const cancelled = new ReconciliationCancelled();
			if (this.inner.isAsync) return Promise.reject(cancelled);
			throw cancelled;
		}
		for (const key of keys) {
			// Removing the guild record closes its partition: every descendant stops being readable with it.
			const guildId = this.layout.guildRecord(key);
			if (guildId !== undefined) this.state.closeGuild(guildId);
		}
		const removal = this.state.beginRemoval(keys.filter(key => this.layout.manages(key)));
		return settle(
			run,
			() => this.state.commitRemoval(removal),
			cause => {
				this.removalFailed(removal, cause);
				this.host.mutationFailed?.(removal.keys, cause);
			},
		);
	}

	private removalFailed(removal: RemovalClaim, cause: unknown): void {
		this.state.abandonRemoval(removal);
		this.state.recordFailure({
			kind: 'removal',
			message: 'A physical removal failed; the affected keys stay hidden until a later reconciliation removes them.',
			key: removal.keys[0],
			cause,
		});
	}
}
