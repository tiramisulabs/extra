import type { Adapter } from 'seyfert';
import {
	type AdapterReconciliationController,
	type StagedRemoveAttempt,
	type StagedRemoves,
	type StagedWrites,
} from './adapter-controller';
import type {
	CoordinatedMutationRequest,
	CoordinatedMutationResult,
	CoordinatedReadRequest,
	CoordinatorBinding,
	ReconciliationCoordinator,
} from './coordinator';
import { LocalMutationBoundary } from './local-mutation-boundary';
import type { DeleteClaim, FlushAttempt, RemoveAttempt, WriteAttempt } from './reconciliation-state';
import { isThenable, TaskLocalScope } from './task-local-scope';

interface ReconciledAdapterHooks {
	beforeStart(): void;
	onFailed(error: unknown): void;
	onStarted(): void;
}

type FailureMode = 'async' | 'sync';
type StartState =
	| { phase: 'idle' }
	| { phase: 'pending'; result: Promise<void> }
	| { phase: 'started' }
	| { phase: 'failed'; error: unknown; mode: FailureMode }
	| { phase: 'closed' };

function valueLock(key: string): string {
	return JSON.stringify(['value', key]);
}

function relationshipLock(to: string): string {
	return JSON.stringify(['relationship-bucket', to]);
}

function snapshotValueEntries(entries: readonly (readonly [string, any])[]): [string, any][] {
	return entries.map(([key, value]) => [key, value]);
}

interface RelationshipMutationSnapshot {
	readonly buckets: readonly { readonly empty: boolean; readonly to: string }[];
	readonly entries: readonly (readonly [string, string])[];
}

function snapshotRelationshipEntries(data: Readonly<Record<string, readonly string[]>>): RelationshipMutationSnapshot {
	const buckets: { empty: boolean; to: string }[] = [];
	const entries: [string, string][] = [];
	for (const [to, ids] of Object.entries(data)) {
		const snapshot = [...ids];
		buckets.push({ empty: snapshot.length === 0, to });
		for (const id of snapshot) entries.push([to, id]);
	}
	return { buckets, entries };
}

function groupRelationshipEntries(
	snapshot: RelationshipMutationSnapshot,
	entries: readonly (readonly [string, string])[],
): Record<string, string[]> {
	const eligible = new Map<string, string[]>();
	for (const [to, id] of entries) {
		const ids = eligible.get(to) ?? [];
		ids.push(id);
		eligible.set(to, ids);
	}
	const grouped: Record<string, string[]> = {};
	for (const bucket of snapshot.buckets) {
		const ids = eligible.get(bucket.to);
		if (bucket.empty || ids) grouped[bucket.to] = ids ?? [];
	}
	return grouped;
}

/** @internal */
export class ReconciledAdapter implements Adapter {
	#boundary: LocalMutationBoundary;
	#closePromise?: Promise<void>;
	#closeRequested = false;
	#isAsync: boolean;
	#readScope = new TaskLocalScope<boolean>();
	#startState: StartState = { phase: 'idle' };

	constructor(
		readonly inner: Adapter,
		private readonly coordinator: ReconciliationCoordinator,
		private readonly hooks: ReconciledAdapterHooks,
		private readonly controller?: AdapterReconciliationController,
		private readonly binding?: CoordinatorBinding,
	) {
		this.#isAsync = inner.isAsync;
		this.#boundary = new LocalMutationBoundary(this.#isAsync);
	}

	get isAsync(): boolean {
		return this.#isAsync;
	}

	start(): void | Promise<void> {
		if (this.#closeRequested) throw new Error('Cache integrity adapter is closing or closed.');
		switch (this.#startState.phase) {
			case 'pending':
				return this.#startState.result;
			case 'started':
				return;
			case 'failed':
				if (this.#startState.mode === 'async') return Promise.reject(this.#startState.error);
				throw this.#startState.error;
			case 'closed':
				throw new Error('Cache integrity adapter is closed.');
			case 'idle':
				break;
		}

		try {
			this.hooks.beforeStart();
			const innerResult = this.inner.start.call(this.inner);
			if (isThenable<void>(innerResult)) {
				return this.trackAsyncStart(Promise.resolve(innerResult).then(() => this.startCoordinator()));
			}
			const coordinatorResult = this.startCoordinator();
			if (isThenable<void>(coordinatorResult)) return this.trackAsyncStart(Promise.resolve(coordinatorResult));
			if (!this.#closeRequested) {
				this.#startState = { phase: 'started' };
				this.hooks.onStarted();
			}
		} catch (error) {
			this.failStart(error, 'sync');
		}
	}

	close(): Promise<void> {
		this.#closeRequested = true;
		this.#closePromise ??= this.closeOnce();
		return this.#closePromise;
	}

	waitForIdle(): Promise<void> {
		return this.#boundary.waitForIdle();
	}

	runUnfiltered<T>(callback: () => T): T {
		return this.#readScope.run(true, callback);
	}

	reconcileDelete(
		key: string,
		claim: DeleteClaim,
		relationship?: { readonly id: string; readonly to: string },
	): ReturnType<Adapter['remove']> {
		if (this.#closeRequested) return this.mutationMiss() as ReturnType<Adapter['remove']>;
		this.#boundary.preflight();
		const locks = relationship ? [claim.key, relationshipLock(relationship.to)] : [claim.key];
		return this.#boundary.run(locks, () => {
			if (!this.controller?.beginPhysicalDelete(claim)) return;
			let result: ReturnType<Adapter['remove']> | Promise<CoordinatedMutationResult>;
			try {
				// The claim transition and storage call intentionally have no await gap.
				result = this.binding?.storage
					? this.coordinatedMutation({ claim, key, kind: 'claimed-delete', relationship })
					: this.removeClaimedValue(key, relationship);
			} catch (error) {
				this.controller.completePhysicalDelete(claim, false);
				throw error;
			}
			return this.settleMutationResult(
				result,
				outcome => this.controller!.completePhysicalDelete(claim, outcome?.admitted[0] ?? true),
				() => this.controller!.completePhysicalDelete(claim, false),
			);
		}) as ReturnType<Adapter['remove']>;
	}

	scan(query: string, keys?: false): ReturnType<Adapter['scan']>;
	scan(query: string, keys: true): ReturnType<Adapter['scan']>;
	scan(query: string, keys?: boolean): ReturnType<Adapter['scan']> {
		if (this.binding?.storage) return this.coordinatedRead('scan', [query, keys]) as ReturnType<Adapter['scan']>;
		if (!this.shouldFilterReads()) {
			return this.invoke('scan', () => this.inner.scan.call(this.inner, query, keys as true));
		}
		const physicalKeys = this.invoke('scan', () => this.inner.scan.call(this.inner, query, true));
		return this.mapResult(physicalKeys, discovered => {
			const visible = (discovered as string[]).filter(key => this.controller!.isValueVisible(key));
			if (keys) return visible;
			return this.invoke('bulkGet', () => this.inner.bulkGet.call(this.inner, visible));
		}) as ReturnType<Adapter['scan']>;
	}

	bulkGet(keys: string[]): ReturnType<Adapter['bulkGet']> {
		if (this.binding?.storage) return this.coordinatedRead('bulk-get', [[...keys]]) as ReturnType<Adapter['bulkGet']>;
		const visible = this.shouldFilterReads() ? keys.filter(key => this.controller!.isValueVisible(key)) : keys;
		return this.invoke('bulkGet', () => this.inner.bulkGet.call(this.inner, visible));
	}

	get(key: string): ReturnType<Adapter['get']> {
		if (this.binding?.storage) return this.coordinatedRead('get', [key]) as ReturnType<Adapter['get']>;
		if (this.shouldFilterReads() && !this.controller!.isValueVisible(key)) {
			return this.readMiss(null) as ReturnType<Adapter['get']>;
		}
		return this.invoke('get', () => this.inner.get.call(this.inner, key));
	}

	bulkSet(keyValue: [string, any][]): ReturnType<Adapter['bulkSet']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['bulkSet']>;
			return this.invoke('bulkSet', () => this.inner.bulkSet.call(this.inner, keyValue));
		}
		const entries = snapshotValueEntries(keyValue);
		const staged = this.controller?.stageValueWrites(entries, 'set');
		return this.runWrite(
			staged?.locks ?? entries.map(([key]) => valueLock(key)),
			entries,
			staged,
			'bulkSet',
			(eligible, attempts) =>
				this.binding?.storage
					? this.coordinatedMutation({
							entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
							kind: 'value-write',
							operation: 'set',
						})
					: this.inner.bulkSet.call(this.inner, eligible),
		);
	}

	set(id: string, data: any): ReturnType<Adapter['set']> {
		if (!this.preflightMutation()) {
			return this.binding?.storage
				? (this.mutationMiss() as ReturnType<Adapter['set']>)
				: this.invoke('set', () => this.inner.set.call(this.inner, id, data));
		}
		const entries: [string, any][] = [[id, data]];
		const staged = this.controller?.stageValueWrites(entries, 'set');
		return this.runWrite(staged?.locks ?? [valueLock(id)], entries, staged, 'set', (eligible, attempts) => {
			if (this.binding?.storage) {
				return this.coordinatedMutation({
					entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
					kind: 'value-write',
					operation: 'set',
				});
			}
			const [key, value] = eligible[0]!;
			return this.inner.set.call(this.inner, key, value);
		});
	}

	bulkPatch(keyValue: [string, any][]): ReturnType<Adapter['bulkPatch']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['bulkPatch']>;
			return this.invoke('bulkPatch', () => this.inner.bulkPatch.call(this.inner, keyValue));
		}
		const entries = snapshotValueEntries(keyValue);
		const staged = this.controller?.stageValueWrites(entries, 'patch');
		return this.runWrite(
			staged?.locks ?? entries.map(([key]) => valueLock(key)),
			entries,
			staged,
			'bulkPatch',
			(eligible, attempts) =>
				this.binding?.storage
					? this.coordinatedMutation({
							entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
							kind: 'value-write',
							operation: 'patch',
						})
					: this.inner.bulkPatch.call(this.inner, eligible),
		);
	}

	patch(id: string, data: any): ReturnType<Adapter['patch']> {
		if (!this.preflightMutation()) {
			return this.binding?.storage
				? (this.mutationMiss() as ReturnType<Adapter['patch']>)
				: this.invoke('patch', () => this.inner.patch.call(this.inner, id, data));
		}
		const entries: [string, any][] = [[id, data]];
		const staged = this.controller?.stageValueWrites(entries, 'patch');
		return this.runWrite(staged?.locks ?? [valueLock(id)], entries, staged, 'patch', (eligible, attempts) => {
			if (this.binding?.storage) {
				return this.coordinatedMutation({
					entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
					kind: 'value-write',
					operation: 'patch',
				});
			}
			const [key, value] = eligible[0]!;
			return this.inner.patch.call(this.inner, key, value);
		});
	}

	values(to: string): ReturnType<Adapter['values']> {
		if (this.binding?.storage) return this.coordinatedRead('values', [to]) as ReturnType<Adapter['values']>;
		if (!this.shouldFilterReads()) return this.invoke('values', () => this.inner.values.call(this.inner, to));
		const ids = this.invoke('getToRelationship', () => this.inner.getToRelationship.call(this.inner, to));
		return this.mapResult(ids, related => {
			const visible = this.controller!.filterRelationshipIds(to, related);
			const keys = visible.map(id => this.controller!.relationshipEntityKey(to, id));
			return this.invoke('bulkGet', () => this.inner.bulkGet.call(this.inner, keys));
		}) as ReturnType<Adapter['values']>;
	}

	keys(to: string): ReturnType<Adapter['keys']> {
		if (this.binding?.storage) return this.coordinatedRead('keys', [to]) as ReturnType<Adapter['keys']>;
		const result = this.invoke('keys', () => this.inner.keys.call(this.inner, to));
		if (!this.shouldFilterReads()) return result;
		return this.mapResult(result, keys => keys.filter(key => this.controller!.isRelationshipKeyVisible(to, key)));
	}

	count(to: string): ReturnType<Adapter['count']> {
		if (this.binding?.storage) return this.coordinatedRead('count', [to]) as ReturnType<Adapter['count']>;
		if (!this.shouldFilterReads()) return this.invoke('count', () => this.inner.count.call(this.inner, to));
		const ids = this.invoke('getToRelationship', () => this.inner.getToRelationship.call(this.inner, to));
		return this.mapResult(ids, related => this.controller!.filterRelationshipIds(to, related).length);
	}

	bulkRemove(keys: string[]): ReturnType<Adapter['bulkRemove']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['bulkRemove']>;
			return this.invoke('bulkRemove', () => this.inner.bulkRemove.call(this.inner, keys));
		}
		const snapshot = [...keys];
		const staged = this.controller?.stageValueRemoves(snapshot);
		return this.runRemove(
			staged?.locks ?? snapshot.map(valueLock),
			snapshot,
			staged,
			'bulkRemove',
			(eligible, attempts) => {
				if (this.binding?.storage) {
					return this.coordinatedMutation({
						entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
						guard: this.controller?.currentDeleteClaim(),
						kind: 'value-remove',
					});
				}
				if (snapshot.length > 0 && eligible.length === 0) return;
				return this.inner.bulkRemove.call(this.inner, eligible);
			},
		);
	}

	remove(key: string): ReturnType<Adapter['remove']> {
		if (!this.preflightMutation()) {
			return this.binding?.storage
				? (this.mutationMiss() as ReturnType<Adapter['remove']>)
				: this.invoke('remove', () => this.inner.remove.call(this.inner, key));
		}
		const staged = this.controller?.stageValueRemoves([key]);
		return this.runRemove(staged?.locks ?? [valueLock(key)], [key], staged, 'remove', (eligible, attempts) => {
			if (this.binding?.storage) {
				return this.coordinatedMutation({
					entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
					guard: this.controller?.currentDeleteClaim(),
					kind: 'value-remove',
				});
			}
			if (eligible.length === 0) return;
			return this.inner.remove.call(this.inner, eligible[0]!);
		});
	}

	flush(): ReturnType<Adapter['flush']> {
		if (!this.preflightMutation()) {
			return this.binding?.storage
				? (this.mutationMiss() as ReturnType<Adapter['flush']>)
				: this.invoke('flush', () => this.inner.flush.call(this.inner));
		}
		const attempt = this.controller?.stageFlush();
		return this.#boundary.flush(() => {
			if (attempt && !this.controller!.beginFlush(attempt)) return;
			let result: ReturnType<Adapter['flush']> | Promise<CoordinatedMutationResult>;
			try {
				result = this.binding?.storage
					? this.coordinatedMutation({ attempt, kind: 'flush' })
					: this.invoke('flush', () => this.inner.flush.call(this.inner));
			} catch (error) {
				if (attempt) this.controller!.completeFlush(attempt, false);
				throw error;
			}
			return this.settleMutationResult(
				result,
				outcome => this.completeFlush(attempt, outcome?.admitted[0] ?? true),
				() => this.completeFlush(attempt, false),
			);
		}) as ReturnType<Adapter['flush']>;
	}

	contains(to: string, key: string): ReturnType<Adapter['contains']> {
		if (this.binding?.storage) return this.coordinatedRead('contains', [to, key]) as ReturnType<Adapter['contains']>;
		if (this.shouldFilterReads() && this.controller!.filterRelationshipIds(to, [key]).length === 0) {
			return this.readMiss(false) as ReturnType<Adapter['contains']>;
		}
		return this.invoke('contains', () => this.inner.contains.call(this.inner, to, key));
	}

	getToRelationship(to: string): ReturnType<Adapter['getToRelationship']> {
		if (this.binding?.storage) {
			return this.coordinatedRead('relationship-ids', [to]) as ReturnType<Adapter['getToRelationship']>;
		}
		const result = this.invoke('getToRelationship', () => this.inner.getToRelationship.call(this.inner, to));
		if (!this.shouldFilterReads()) return result;
		return this.mapResult(result, ids => this.controller!.filterRelationshipIds(to, ids));
	}

	bulkAddToRelationShip(data: Record<string, string[]>): ReturnType<Adapter['bulkAddToRelationShip']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['bulkAddToRelationShip']>;
			return this.invoke('bulkAddToRelationShip', () => this.inner.bulkAddToRelationShip.call(this.inner, data));
		}
		const snapshot = snapshotRelationshipEntries(data);
		const emptyBuckets = snapshot.buckets.filter(bucket => bucket.empty).map(bucket => bucket.to);
		const staged = this.controller?.stageRelationshipWrites(snapshot.entries, emptyBuckets);
		return this.runWrite(
			staged?.locks ?? snapshot.buckets.map(bucket => relationshipLock(bucket.to)),
			snapshot.entries,
			staged,
			'bulkAddToRelationShip',
			(eligible, attempts) =>
				this.binding?.storage
					? this.coordinatedMutation({
							entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
							kind: 'relationship-add',
						})
					: this.inner.bulkAddToRelationShip.call(this.inner, groupRelationshipEntries(snapshot, eligible)),
			snapshot.buckets.some(bucket => bucket.empty),
		);
	}

	addToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['addToRelationship']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['addToRelationship']>;
			return this.invoke('addToRelationship', () => this.inner.addToRelationship.call(this.inner, to, keys));
		}
		const multiple = Array.isArray(keys);
		const entries: [string, string][] = (multiple ? [...keys] : [keys]).map(id => [to, id]);
		const staged = this.controller?.stageRelationshipWrites(entries, entries.length === 0 ? [to] : []);
		return this.runWrite(
			staged?.locks ?? [relationshipLock(to)],
			entries,
			staged,
			'addToRelationship',
			(eligible, attempts) =>
				this.binding?.storage
					? this.coordinatedMutation({
							entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
							kind: 'relationship-add',
						})
					: this.inner.addToRelationship.call(
							this.inner,
							to,
							multiple ? eligible.map(([, id]) => id) : eligible[0]![1],
						),
		);
	}

	removeToRelationship(to: string, keys: string | string[]): ReturnType<Adapter['removeToRelationship']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['removeToRelationship']>;
			return this.invoke('removeToRelationship', () => this.inner.removeToRelationship.call(this.inner, to, keys));
		}
		const multiple = Array.isArray(keys);
		const ids = multiple ? [...keys] : [keys];
		const originallyEmpty = ids.length === 0;
		const entries: [string, string][] = ids.map(id => [to, id]);
		const staged = this.controller?.stageRelationshipRemoves(entries, originallyEmpty ? [to] : []);
		return this.runRemove(
			staged?.locks ?? [relationshipLock(to)],
			ids,
			staged,
			'removeToRelationship',
			(eligible, attempts) => {
				if (this.binding?.storage) {
					return this.coordinatedMutation({
						entries: eligible.map((id, index) => ({ attempt: attempts[index], value: [to, id] })),
						guard: this.controller?.currentDeleteClaim(),
						kind: 'relationship-remove',
					});
				}
				if (eligible.length === 0 && !originallyEmpty) return;
				return this.inner.removeToRelationship.call(this.inner, to, multiple ? eligible : eligible[0]!);
			},
		);
	}

	removeRelationship(to: string | string[]): ReturnType<Adapter['removeRelationship']> {
		if (!this.preflightMutation()) {
			if (this.binding?.storage) return this.mutationMiss() as ReturnType<Adapter['removeRelationship']>;
			return this.invoke('removeRelationship', () => this.inner.removeRelationship.call(this.inner, to));
		}
		const multiple = Array.isArray(to);
		const relationships = multiple ? [...to] : [to];
		const originallyEmpty = relationships.length === 0;
		const staged = this.controller?.stageRelationshipClears(relationships);
		return this.runRemove(
			staged?.locks ?? relationships.map(relationshipLock),
			relationships,
			staged,
			'removeRelationship',
			(eligible, attempts) => {
				if (this.binding?.storage) {
					return this.coordinatedMutation({
						entries: eligible.map((value, index) => ({ attempt: attempts[index], value })),
						guard: this.controller?.currentDeleteClaim(),
						kind: 'relationship-clear',
					});
				}
				if (eligible.length === 0 && !originallyEmpty) return;
				return this.inner.removeRelationship.call(this.inner, multiple ? eligible : eligible[0]!);
			},
		);
	}

	private startCoordinator(): void | Promise<void> {
		if (this.#closeRequested) return;
		return this.coordinator.start();
	}

	private coordinatedRead(kind: CoordinatedReadRequest['kind'], args: unknown[]) {
		return this.binding!.storage!.read({
			args,
			generation: this.controller?.currentGeneration(),
			guard: this.controller?.currentDeleteClaim(),
			kind,
			unfiltered: this.isUnfiltered(),
		});
	}

	private coordinatedMutation(request: CoordinatedMutationRequest): Promise<CoordinatedMutationResult> {
		return this.binding!.storage!.mutate(request);
	}

	private trackAsyncStart(result: Promise<void>): Promise<void> {
		const tracked = result.then(
			() => {
				if (this.#closeRequested) return;
				this.#startState = { phase: 'started' };
				this.hooks.onStarted();
			},
			error => this.failStart(error, 'async'),
		);
		this.#startState = { phase: 'pending', result: tracked };
		return tracked;
	}

	private failStart(error: unknown, mode: FailureMode): never {
		this.#startState = { phase: 'failed', error, mode };
		if (!this.#closeRequested) this.hooks.onFailed(error);
		throw error;
	}

	private async closeOnce(): Promise<void> {
		const start = this.#startState.phase === 'pending' ? this.#startState.result : undefined;
		if (start) await start.catch(() => undefined);
		try {
			await this.#boundary.waitForIdle();
			await this.coordinator.close();
		} finally {
			this.#startState = { phase: 'closed' };
		}
	}

	private invoke<T>(method: string, operation: () => T): T {
		const result = operation();
		if (!this.#isAsync && isThenable(result)) {
			void Promise.resolve(result).then(
				() => undefined,
				() => undefined,
			);
			throw new TypeError(`Synchronous cache adapter method ${method} returned a thenable.`);
		}
		return result;
	}

	private mapResult<T, U>(result: T | PromiseLike<T>, transform: (value: T) => U | PromiseLike<U>): U | Promise<U> {
		return isThenable<T>(result) ? Promise.resolve(result).then(transform) : (transform(result) as U);
	}

	private settleMutationResult(
		result: void | PromiseLike<void | CoordinatedMutationResult>,
		onSuccess: (outcome: CoordinatedMutationResult | undefined) => void,
		onFailure: () => void,
	): void | Promise<void> {
		if (isThenable(result)) {
			return Promise.resolve(result).then(
				value => {
					onSuccess(value || undefined);
				},
				error => {
					onFailure();
					throw error;
				},
			);
		}
		onSuccess(undefined);
	}

	private runWrite<T>(
		locks: readonly string[],
		values: readonly T[],
		staged: StagedWrites | undefined,
		method: string,
		operation: (
			eligible: T[],
			attempts: readonly (WriteAttempt | undefined)[],
		) => ReturnType<Adapter['set']> | Promise<CoordinatedMutationResult>,
		invokeWhenEligibleEmpty = false,
	): ReturnType<Adapter['set']> {
		return this.#boundary.run(locks, () => {
			const begun: WriteAttempt[] = [];
			const eligibleAttempts: (WriteAttempt | undefined)[] = [];
			const eligible = values.filter((_, index) => {
				const attempt = staged?.attempts[index];
				if (attempt === 'denied') return false;
				if (!attempt) {
					eligibleAttempts.push(undefined);
					return true;
				}
				if (!this.controller!.isCurrentContextAdmitted()) {
					if (this.controller!.beginWrite(attempt)) this.controller!.rejectWrites([attempt]);
					return false;
				}
				if (!this.controller!.beginWrite(attempt)) return false;
				begun.push(attempt);
				eligibleAttempts.push(attempt);
				return true;
			});
			let result: ReturnType<Adapter['set']> | Promise<CoordinatedMutationResult>;
			try {
				result =
					values.length > 0 && eligible.length === 0 && !invokeWhenEligibleEmpty
						? undefined
						: this.invoke(method, () => operation(eligible, eligibleAttempts));
			} catch (error) {
				this.controller?.completeWrites(begun, false);
				throw error;
			}
			return this.settleMutationResult(
				result,
				outcome => {
					if (!outcome) {
						this.controller?.completeWrites(begun, true);
						return;
					}
					for (let index = 0; index < eligibleAttempts.length; index++) {
						const attempt = eligibleAttempts[index];
						if (!attempt) continue;
						if (outcome.admitted[index]) this.controller?.completeWrites([attempt], true);
						else this.controller?.rejectWrites([attempt]);
					}
				},
				() => this.controller?.completeWrites(begun, false),
			);
		}) as ReturnType<Adapter['set']>;
	}

	private runRemove(
		locks: readonly string[],
		values: readonly string[],
		staged: StagedRemoves | undefined,
		method: string,
		operation: (
			eligible: string[],
			attempts: readonly (RemoveAttempt | DeleteClaim | undefined)[],
		) => ReturnType<Adapter['remove']> | Promise<CoordinatedMutationResult>,
	): ReturnType<Adapter['remove']> {
		return this.#boundary.run(locks, () => {
			const begun: StagedRemoveAttempt[] = [];
			const eligibleAttempts: (RemoveAttempt | DeleteClaim | undefined)[] = [];
			const eligibleGroups: StagedRemoveAttempt[][] = [];
			const eligible = values.filter((_, index) => {
				const group = staged?.attempts[index];
				if (group === 'denied') return false;
				if (!group) {
					eligibleAttempts.push(undefined);
					eligibleGroups.push([]);
					return true;
				}
				if (!this.controller!.isCurrentContextAdmitted()) {
					const rejected: StagedRemoveAttempt[] = [];
					for (const stagedAttempt of group) {
						if (stagedAttempt.kind === 'remove' && this.controller!.beginRemove(stagedAttempt.attempt)) {
							rejected.push(stagedAttempt);
						}
					}
					this.completeRemoves(rejected, false);
					return false;
				}
				const groupBegun: StagedRemoveAttempt[] = [];
				for (const stagedAttempt of group) {
					const admitted =
						stagedAttempt.kind === 'claim'
							? this.controller!.beginPhysicalDelete(stagedAttempt.claim)
							: this.controller!.beginRemove(stagedAttempt.attempt);
					if (!admitted) {
						this.completeRemoves(groupBegun, false);
						return false;
					}
					groupBegun.push(stagedAttempt);
				}
				begun.push(...groupBegun);
				eligibleGroups.push(groupBegun);
				eligibleAttempts.push(
					groupBegun.length === 1
						? groupBegun[0]!.kind === 'claim'
							? groupBegun[0]!.claim
							: groupBegun[0]!.attempt
						: undefined,
				);
				return true;
			});
			let result: ReturnType<Adapter['remove']> | Promise<CoordinatedMutationResult>;
			try {
				result = this.invoke(method, () => operation(eligible, eligibleAttempts));
			} catch (error) {
				this.completeRemoves(begun, false);
				throw error;
			}
			return this.settleMutationResult(
				result,
				outcome => {
					if (!outcome) {
						this.completeRemoves(begun, true);
						return;
					}
					for (let index = 0; index < eligibleGroups.length; index++) {
						this.completeRemoves(eligibleGroups[index]!, outcome.admitted[index] ?? false);
					}
				},
				() => this.completeRemoves(begun, false),
			);
		}) as ReturnType<Adapter['remove']>;
	}

	private completeRemoves(attempts: readonly StagedRemoveAttempt[], succeeded: boolean): void {
		for (const staged of attempts) {
			if (staged.kind === 'claim') {
				this.controller!.completePhysicalDelete(staged.claim, succeeded && staged.physicallyRemoved);
			} else {
				this.controller!.completeRemove(staged.attempt, succeeded && staged.physicallyRemoved);
			}
		}
	}

	private removeClaimedValue(
		key: string,
		relationship: { readonly id: string; readonly to: string } | undefined,
	): ReturnType<Adapter['remove']> {
		if (!relationship) return this.invoke('remove', () => this.inner.remove.call(this.inner, key));
		const valueResult = this.invoke('remove', () => this.inner.remove.call(this.inner, key));
		return this.mapResult(valueResult, () =>
			this.invoke('removeToRelationship', () =>
				this.inner.removeToRelationship.call(this.inner, relationship.to, relationship.id),
			),
		) as ReturnType<Adapter['remove']>;
	}

	private completeFlush(attempt: FlushAttempt | undefined, succeeded: boolean): void {
		if (attempt) this.controller!.completeFlush(attempt, succeeded);
	}

	private preflightMutation(): boolean {
		// Teardown seals reconciler work, not the caller-owned adapter; later public mutations delegate outside the drain.
		if (this.#closeRequested) return false;
		this.#boundary.preflight();
		return true;
	}

	private shouldFilterReads(): boolean {
		return this.controller !== undefined && !this.isUnfiltered();
	}

	private readMiss<T>(value: T): T | Promise<T> {
		return this.#isAsync ? Promise.resolve(value) : value;
	}

	private mutationMiss(): void | Promise<void> {
		return this.#isAsync ? Promise.resolve() : undefined;
	}

	private isUnfiltered(): boolean {
		return this.#readScope.get() === true;
	}
}
