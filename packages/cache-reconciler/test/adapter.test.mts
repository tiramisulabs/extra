import { type Adapter, type AdapterEntry, Cache, MemoryAdapter } from 'seyfert';
import { describe, expect, it } from 'vitest';
import { ReconciledAdapter } from '../src/adapter';
import { ReconciliationCancelled } from '../src/coordinator';
import { memoryCoordinator } from '../src/coordinators/memory';
import { KeyLayout } from '../src/keys';
import { ReconciliationState, type SnapshotCut } from '../src/state';
import { isThenable } from '../src/sync';
import { APPLICATION_ID, AsyncAdapter, deferred, guildOn } from './support';

const G = guildOn(2);
const ROLES = `role.${G}`;

const role1: AdapterEntry = ['role.1', { id: '1', name: 'one' }, [ROLES, '1']];
const role2: AdapterEntry = ['role.2', { id: '2', name: 'two' }, [ROLES, '2']];
/** Written straight to the store: it predates everything the reconciler observed. */
const ghost: AdapterEntry = ['role.9', { id: '9', name: 'ghost' }, [ROLES, '9']];
/** Another plugin's resource on the same adapter. */
const unmanaged: AdapterEntry = ['cooldown.a', { uses: 1 }, ['cooldown', 'a']];

type AdapterMethod = Exclude<keyof Adapter, 'isAsync'>;

function harness(inner: Adapter) {
	const state = new ReconciliationState();
	const layout = new KeyLayout(() => APPLICATION_ID);
	const binding = memoryCoordinator().bind({ inner, state, layout });
	const adapter = new ReconciledAdapter(inner, { state, layout, binding });
	const store = inner instanceof AsyncAdapter ? inner.memory : (inner as MemoryAdapter<unknown>);
	return { adapter, inner, store, state, layout, binding };
}

/** Makes the next call of `method` fail the way the adapter kind fails: a throw, or a rejection. */
function failNext(inner: Adapter, method: AdapterMethod, error: unknown, partial?: () => void): void {
	if (inner instanceof AsyncAdapter) {
		inner.failNext(method, error, partial);
		return;
	}
	const target = inner as unknown as Record<string, unknown>;
	target[method] = () => {
		delete target[method];
		partial?.();
		throw error;
	};
}

/**
 * The error a failing adapter call surfaces. It also holds the call to its adapter's contract: a synchronous
 * adapter throws, an asynchronous one returns a rejection.
 */
async function outcome(inner: Adapter, run: () => unknown): Promise<unknown> {
	let result: unknown;
	try {
		result = run();
	} catch (error) {
		expect(inner.isAsync, 'an asynchronous adapter must reject instead of throwing').toBe(false);
		return error;
	}
	expect(isThenable(result), 'a synchronous adapter must throw instead of rejecting').toBe(inner.isAsync);
	return rejection(() => result);
}

async function rejection(run: () => unknown): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return 'no error';
}

/** A generation in which `guildId` is not listed by READY, with the claim that may remove what is left of it. */
function staleGuild(state: ReconciliationState, guildId: string) {
	state.activate();
	state.ready(0, 'session-1', 1, [], 1);
	const generation = state.guildsReady(0)!;
	return state.claimGuild(generation, guildId)!;
}

/** A generation in which `guildId` was opened by its startup snapshot at sequence 2. */
function openGuild(state: ReconciliationState, guildId: string): SnapshotCut {
	state.activate();
	state.ready(0, 'session-1', 1, [guildId], 1);
	const work = state.guildAvailable(0, guildId, 2, { startup: true, unavailable: false })!;
	return { generation: work.generation, guildId, sequence: 2 };
}

const variants = [
	['synchronous', (): Adapter => new MemoryAdapter()],
	['asynchronous', (): Adapter => new AsyncAdapter()],
] as const;

describe.each(variants)('ReconciledAdapter over a %s adapter', (_kind, create) => {
	it('returns directly or as a promise exactly like the wrapped adapter, for every member', async () => {
		const { adapter, inner, store } = harness(create());
		store.set(...ghost);
		const calls: [name: string, call: () => unknown][] = [
			['start', () => adapter.start()],
			['set', () => adapter.set(...role1)],
			['patch', () => adapter.patch('role.1', { color: 1 }, [ROLES, '1'])],
			['bulkSet', () => adapter.bulkSet([role2, unmanaged])],
			['bulkPatch', () => adapter.bulkPatch([['role.2', { color: 2 }, [ROLES, '2']]])],
			['get hit', () => adapter.get('role.1')],
			['get miss', () => adapter.get('role.9')],
			['get unmanaged', () => adapter.get('cooldown.a')],
			['bulkGet', () => adapter.bulkGet(['role.1', 'role.9'])],
			['bulkGet unmanaged', () => adapter.bulkGet(['cooldown.a'])],
			['scan values', () => adapter.scan('role.*')],
			['scan keys', () => adapter.scan('role.*', true)],
			['scan unmanaged', () => adapter.scan('cooldown.*')],
			['keys', () => adapter.keys(ROLES)],
			['values', () => adapter.values(ROLES)],
			['count', () => adapter.count(ROLES)],
			['contains', () => adapter.contains(ROLES, '1')],
			['getToRelationship', () => adapter.getToRelationship(ROLES)],
			['keys unmanaged', () => adapter.keys('cooldown')],
			['increment hit', () => adapter.increment!('role.1', 'color', 1)],
			['increment miss', () => adapter.increment!('role.9', 'color', 1)],
			['remove', () => adapter.remove('role.1')],
			['bulkRemove', () => adapter.bulkRemove(['role.2'])],
			['removeToRelationship', () => adapter.removeToRelationship(ROLES, ['9'])],
			['removeRelationship', () => adapter.removeRelationship(ROLES)],
			['flush', () => adapter.flush()],
		];

		expect(adapter.isAsync).toBe(inner.isAsync);
		for (const [name, call] of calls) {
			const result = call();
			expect(isThenable(result), name).toBe(inner.isAsync);
			await result;
		}
	});

	it('serves only visible entries from every read and passes unmanaged resources through', async () => {
		const { adapter, store } = harness(create());
		await adapter.bulkSet([role1, role2]);
		store.set(...ghost);
		store.set(...unmanaged);

		expect(await adapter.get('role.1')).toEqual(role1[1]);
		expect(await adapter.get('role.9')).toBeNull();
		expect(await adapter.get('cooldown.a')).toEqual(unmanaged[1]);
		// Positions are not preserved for missing entries, so the ghost simply is not there.
		expect(await adapter.bulkGet(['role.9', 'role.1', 'cooldown.a'])).toEqual([role1[1], unmanaged[1]]);
		expect(await adapter.scan('role.*')).toEqual([role1[1], role2[1]]);
		expect(await adapter.scan('role.*', true)).toEqual(['role.1', 'role.2']);
		expect(await adapter.scan('*.9', true)).toEqual([]);
		expect(await adapter.scan('cooldown.*', true)).toEqual(['cooldown.a']);
		expect(await adapter.keys(ROLES)).toEqual(['role.1', 'role.2']);
		expect(await adapter.values(ROLES)).toEqual([role1[1], role2[1]]);
		expect(await adapter.count(ROLES)).toBe(2);
		expect(await adapter.contains(ROLES, '1')).toBe(true);
		expect(await adapter.contains(ROLES, '9')).toBe(false);
		expect(await adapter.getToRelationship(ROLES)).toEqual(['1', '2']);
		expect(await adapter.keys('cooldown')).toEqual(['cooldown.a']);
		expect(await adapter.count('cooldown')).toBe(1);
		// The store still holds the ghost: hiding is not deleting.
		expect(store.count(ROLES)).toBe(3);
	});

	it.each([
		['set', (adapter: Adapter) => adapter.set(...role1)],
		['patch', (adapter: Adapter) => adapter.patch(...role1)],
		['bulkSet', (adapter: Adapter) => adapter.bulkSet([role1])],
		['bulkPatch', (adapter: Adapter) => adapter.bulkPatch([role1])],
	] as const)('%s makes an entry visible only after the write succeeded', async (method, write) => {
		const { adapter, inner } = harness(create());
		const held = deferred();
		if (inner instanceof AsyncAdapter) inner.gate(method, held.promise);

		const writing = write(adapter);
		if (inner instanceof AsyncAdapter) expect(await adapter.get('role.1')).toBeNull();
		held.resolve();
		await writing;

		expect(await adapter.get('role.1')).toEqual(role1[1]);
		expect(await adapter.keys(ROLES)).toEqual(['role.1']);
	});

	it.each([
		['set', (adapter: Adapter) => adapter.set('role.1', { id: '1', name: 'changed' }, [ROLES, '1'])],
		['patch', (adapter: Adapter) => adapter.patch('role.1', { name: 'changed' }, [ROLES, '1'])],
		['bulkSet', (adapter: Adapter) => adapter.bulkSet([role2, ['role.1', { id: '1', name: 'changed' }, [ROLES, '1']]])],
		['bulkPatch', (adapter: Adapter) => adapter.bulkPatch([['role.1', { name: 'changed' }, [ROLES, '1']]])],
	] as const)('a failed %s changes no visibility and reports the failure', async (method, write) => {
		const { adapter, inner, state } = harness(create());
		await adapter.set(...role1);
		const error = new Error(`${method} failed`);
		failNext(inner, method, error);

		expect(await outcome(inner, () => write(adapter))).toBe(error);

		expect(await adapter.get('role.1')).toEqual(role1[1]);
		expect(await adapter.get('role.2')).toBeNull();
		expect(await adapter.keys(ROLES)).toEqual(['role.1']);
		expect(state.snapshot().failures).toEqual([expect.objectContaining({ kind: 'write', cause: error })]);
		// The failed attempt did not leave a fence behind: the same key can be written and removed normally.
		await adapter.set(...role2);
		expect(await adapter.get('role.2')).toEqual(role2[1]);
	});

	it.each([
		['remove', (adapter: Adapter) => adapter.remove('role.1')],
		['bulkRemove', (adapter: Adapter) => adapter.bulkRemove(['role.1'])],
		['removeToRelationship', (adapter: Adapter) => adapter.removeToRelationship(ROLES, '1')],
		['removeRelationship', (adapter: Adapter) => adapter.removeRelationship(ROLES)],
	] as const)('%s hides the entry before the store removes it', async (method, remove) => {
		const { adapter, inner, store, state } = harness(create());
		await adapter.set(...role1);
		const held = deferred();
		if (inner instanceof AsyncAdapter) inner.gate(method, held.promise);

		const removing = remove(adapter);
		if (inner instanceof AsyncAdapter) {
			expect(store.get('role.1')).not.toBeNull();
			expect(await adapter.get('role.1')).toBeNull();
			expect(await adapter.contains(ROLES, '1')).toBe(false);
		}
		held.resolve();
		await removing;

		expect(store.get('role.1')).toBeNull();
		expect(await adapter.get('role.1')).toBeNull();
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it.each([
		['remove', (adapter: Adapter) => adapter.remove('role.1')],
		['bulkRemove', (adapter: Adapter) => adapter.bulkRemove(['role.1'])],
		['removeToRelationship', (adapter: Adapter) => adapter.removeToRelationship(ROLES, '1')],
		['removeRelationship', (adapter: Adapter) => adapter.removeRelationship(ROLES)],
	] as const)('a failed %s keeps the entry absent from every read and reports pending cleanup', async (method, remove) => {
		const { adapter, inner, store, state } = harness(create());
		await adapter.bulkSet([role1, role2]);
		await adapter.remove('role.2');
		const error = new Error(`${method} failed`);
		failNext(inner, method, error);

		expect(await outcome(inner, () => remove(adapter))).toBe(error);

		// The store still has it, but no read path exposes it again.
		expect(store.get('role.1')).not.toBeNull();
		expect(await adapter.get('role.1')).toBeNull();
		expect(await adapter.bulkGet(['role.1'])).toEqual([]);
		expect(await adapter.scan('role.*', true)).toEqual([]);
		expect(await adapter.keys(ROLES)).toEqual([]);
		expect(await adapter.values(ROLES)).toEqual([]);
		expect(await adapter.count(ROLES)).toBe(0);
		expect(await adapter.contains(ROLES, '1')).toBe(false);
		expect(await adapter.getToRelationship(ROLES)).toEqual([]);
		expect(state.snapshot()).toMatchObject({
			pending: { deletions: 1 },
			failures: [expect.objectContaining({ kind: 'removal', cause: error })],
		});
	});

	it('keeps the value hidden when the store dropped the relationship and then failed to drop the value', async () => {
		const { adapter, inner, store, state } = harness(create());
		await adapter.set(...role1);
		const error = new Error('value removal failed');
		failNext(inner, 'remove', error, () => {
			// The relationship member is gone, the value is still stored.
			store.remove('role.1');
			store.set('role.1', role1[1], ['orphaned', '1']);
		});

		expect(await outcome(inner, () => adapter.remove('role.1'))).toBe(error);

		expect(store.get('role.1')).toEqual(role1[1]);
		expect(await adapter.get('role.1')).toBeNull();
		expect(await adapter.getToRelationship(ROLES)).toEqual([]);
		// No synthetic rollback: the relationship stays as the store left it.
		expect(store.getToRelationship(ROLES)).toEqual([]);
		expect(state.snapshot().pending.deletions).toBe(1);
	});

	it('hides everything from the moment a flush is issued, even when it fails', async () => {
		const { adapter, inner, store, state } = harness(create());
		await adapter.bulkSet([role1, unmanaged]);
		const error = new Error('flush failed');
		failNext(inner, 'flush', error);

		expect(await outcome(inner, () => adapter.flush())).toBe(error);
		expect(store.get('role.1')).not.toBeNull();
		expect(await adapter.get('role.1')).toBeNull();
		expect(state.snapshot().failures).toEqual([expect.objectContaining({ kind: 'removal', cause: error })]);

		await adapter.flush();
		expect(store.get('role.1')).toBeNull();
		expect(await adapter.get('cooldown.a')).toBeNull();
	});

	it.each([
		['patch', (adapter: Adapter) => adapter.patch('channel.7', { status: 'live' }, [`channel.${G}`, '7'])],
		['bulkPatch', (adapter: Adapter) => adapter.bulkPatch([['channel.7', { status: 'live' }, [`channel.${G}`, '7']]])],
	] as const)('%s on an entry the caller cannot read replaces it instead of merging into the ghost', async (_method, patch) => {
		const { adapter, store } = harness(create());
		store.set('channel.7', { id: '7', name: 'deleted-offline', topic: 'stale' }, [`channel.${G}`, '7']);

		await patch(adapter);

		// A partial write validates the key, so nothing the ghost held may come along with it.
		expect(await adapter.get('channel.7')).toEqual({ status: 'live' });
	});

	it('merges a patch into readable entries and replaces the rest of the same batch', async () => {
		const { adapter, store } = harness(create());
		await adapter.set(...role1);
		store.set(...ghost);
		store.set(...unmanaged);

		await adapter.bulkPatch([
			['role.1', { color: 5 }, [ROLES, '1']],
			['role.9', { color: 9 }, [ROLES, '9']],
			['cooldown.a', { last: 1 }, ['cooldown', 'a']],
		]);

		expect(await adapter.get('role.1')).toEqual({ id: '1', name: 'one', color: 5 });
		expect(await adapter.get('role.9')).toEqual({ color: 9 });
		// Another plugin's resource keeps plain patch semantics.
		expect(await adapter.get('cooldown.a')).toEqual({ uses: 1, last: 1 });
	});

	it('confirms only the part of a patch batch the store accepted', async () => {
		const { adapter, inner } = harness(create());
		await adapter.set(...role1);
		const error = new Error('bulkPatch failed');
		failNext(inner, 'bulkPatch', error);

		// role.2 is new to the caller and is replaced; role.1 is readable and merged, and that half fails.
		expect(await outcome(inner, () => adapter.bulkPatch([role2, ['role.1', { name: 'changed' }, [ROLES, '1']]]))).toBe(
			error,
		);

		expect(await adapter.get('role.2')).toEqual(role2[1]);
		expect(await adapter.get('role.1')).toEqual(role1[1]);
	});

	it('clears pending cleanup when a failed relationship removal is retried', async () => {
		const { adapter, inner, state } = harness(create());
		await adapter.set(...role1);
		failNext(inner, 'removeToRelationship', new Error('removeToRelationship failed'));
		await rejection(() => adapter.removeToRelationship(ROLES, '1'));
		expect(state.snapshot().pending.deletions).toBe(1);

		await adapter.removeToRelationship(ROLES, '1');

		expect(state.snapshot().pending.deletions).toBe(0);
		expect(state.visibility('role.1')).toBe('unknown-preserved');
	});

	it('ties a message to the guild of the channel it was filed under', async () => {
		const { adapter, state } = harness(create());
		openGuild(state, G);
		await adapter.set('channel.7', { id: '7', type: 0 }, [`channel.${G}`, '7']);
		await adapter.set('message.8', { id: '8' }, ['message.7', '8']);
		await adapter.set('message.9', { id: '9' }, ['message.555', '9']);
		expect(await adapter.keys('message.7')).toEqual(['message.8']);

		// The guild is gone: its messages go with it, a message of an unknown or DM channel does not.
		state.closeGuild(G);

		expect(await adapter.get('message.8')).toBeNull();
		expect(await adapter.keys('message.7')).toEqual([]);
		expect(await adapter.get('message.9')).toEqual({ id: '9' });
	});

	it('increments only entries the caller can read', async () => {
		const { adapter, store } = harness(create());
		await adapter.set('guild.1', { id: '1', member_count: 5 }, ['guild', '1']);
		store.set('guild.9', { id: '9', member_count: 5 }, ['guild', '9']);
		store.set('cooldown.a', { uses: 1 }, ['cooldown', 'a']);

		expect(await adapter.increment!('guild.1', 'member_count', 2)).toBe(7);
		expect(await adapter.increment!('guild.9', 'member_count', 2)).toBeUndefined();
		expect(await adapter.increment!('cooldown.a', 'uses', 1)).toBe(2);

		expect(store.get('guild.9')).toMatchObject({ member_count: 5 });
	});

	it('closes a guild partition when its record is removed', async () => {
		const { adapter, store, state } = harness(create());
		openGuild(state, G);
		await adapter.bulkSet([[`guild.${G}`, { id: G }, ['guild', G]], role1]);
		expect(await adapter.get('role.1')).toEqual(role1[1]);

		await adapter.remove(`guild.${G}`);

		expect(await adapter.get('role.1')).toBeNull();
		expect(await adapter.keys(ROLES)).toEqual([]);
		expect(store.get('role.1')).not.toBeNull();
	});

	it('starts the wrapped adapter before the coordinator, once, and only then admits work', async () => {
		const { adapter, inner, binding, state } = harness(create());
		const order: string[] = [];
		const innerStart = inner.start.bind(inner);
		inner.start = () => {
			order.push(`inner while ${state.lifecycle}`);
			return innerStart();
		};
		binding.start = () => {
			order.push(`coordinator while ${state.lifecycle}`);
		};

		await adapter.start();
		await adapter.start();

		expect(order).toEqual(['inner while installing', 'coordinator while installing']);
		expect(state.lifecycle).toBe('active');
	});

	it.each(['inner', 'coordinator'] as const)('makes a failed %s start terminal', async failing => {
		const { adapter, inner, binding, state } = harness(create());
		const cause = new Error(`${failing} start failed`);
		let innerStarts = 0;
		inner.start = () => {
			innerStarts++;
			if (failing !== 'inner') return inner.isAsync ? Promise.resolve() : undefined;
			if (inner.isAsync) return Promise.reject(cause);
			throw cause;
		};
		if (failing === 'coordinator') {
			binding.start = () => {
				throw cause;
			};
		}

		expect(await outcome(inner, () => adapter.start())).toBe(cause);
		expect(await outcome(inner, () => adapter.start())).toBe(cause);

		expect(innerStarts).toBe(1);
		expect(state.snapshot()).toMatchObject({ lifecycle: 'failed', cause });
	});

	it('answers a membership check without reading the whole relationship', async () => {
		const { adapter, inner, store } = harness(create());
		await adapter.set(...role1);
		store.set(...ghost);
		const called: string[] = [];
		for (const method of ['contains', 'getToRelationship'] as const) {
			const original = (inner[method] as (...args: unknown[]) => unknown).bind(inner);
			(inner as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
				called.push(method);
				return original(...args);
			};
		}

		expect(await adapter.contains(ROLES, '1')).toBe(true);
		expect(await adapter.contains(ROLES, '9')).toBe(false);

		expect(called).toEqual(['contains']);
	});

	it('keeps delegating through an adapter another plugin instrumented in place', async () => {
		const { adapter, inner } = harness(create());
		await adapter.set(...role1);
		const instrumented: string[] = [];
		for (const method of ['get', 'bulkGet', 'set', 'remove', 'getToRelationship'] as const) {
			const original = (inner[method] as (...args: unknown[]) => unknown).bind(inner);
			(inner as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
				instrumented.push(method);
				return original(...args);
			};
		}

		await adapter.get('role.1');
		await adapter.values(ROLES);
		await adapter.set(...role2);
		await adapter.remove('role.2');

		expect(instrumented).toEqual(['get', 'getToRelationship', 'bulkGet', 'set', 'remove']);
	});

	it('does not route its own work through methods a later plugin replaced on the wrapper', async () => {
		const { adapter } = harness(create());
		await adapter.set(...role1);
		const outer: string[] = [];
		const bulkGet = adapter.bulkGet.bind(adapter);
		adapter.bulkGet = keys => {
			outer.push('bulkGet');
			return bulkGet(keys);
		};

		expect(await adapter.values(ROLES)).toEqual([role1[1]]);
		expect(await adapter.bulkGet(['role.1'])).toEqual([role1[1]]);

		expect(outer).toEqual(['bulkGet']);
	});
});

describe('synchronous failures', () => {
	it('rethrows a synchronous throw synchronously instead of returning a rejection', () => {
		const { adapter, inner } = harness(new MemoryAdapter());
		const error = new Error('set failed');
		failNext(inner, 'set', error);

		expect(() => adapter.set(...role1)).toThrow(error);
		expect(adapter.get('role.1')).toBeNull();
	});
});

describe('increment capability', () => {
	it('is absent while the wrapped adapter cannot increment and appears when start() reveals it', async () => {
		const inner = new AsyncAdapter() as AsyncAdapter & { increment?: Adapter['increment'] };
		const increment = inner.increment.bind(inner);
		Object.defineProperty(inner, 'increment', { value: undefined, writable: true });
		const { adapter } = harness(inner);
		expect(adapter.increment).toBeUndefined();

		inner.start = async () => {
			inner.increment = increment;
		};
		await adapter.start();
		await adapter.set('guild.1', { id: '1', member_count: 1 }, ['guild', '1']);

		expect(await adapter.increment!('guild.1', 'member_count', 4)).toBe(5);
	});
});

describe('unfiltered reconciliation scope', () => {
	it('lets the engine read hidden entries while a concurrent caller stays filtered', async () => {
		const inner = new AsyncAdapter();
		const { adapter, state } = harness(inner);
		inner.memory.set(...ghost);
		const claim = staleGuild(state, G);
		const held = deferred();
		inner.gate('get', held.promise);

		const engine = adapter.runUnfiltered(claim, async () => {
			const value = await adapter.get('role.9');
			// Still unfiltered after an await, and inside a nested scope.
			const nested = await adapter.runUnfiltered(claim, () => adapter.keys(ROLES));
			return { value, nested, after: await adapter.getToRelationship(ROLES) };
		});
		const caller = { get: await adapter.get('role.9'), keys: await adapter.keys(ROLES) };
		held.resolve();

		expect(await engine).toEqual({ value: ghost[1], nested: ['role.9'], after: ['9'] });
		expect(caller).toEqual({ get: null, keys: [] });
		expect(await adapter.get('role.9')).toBeNull();
	});

	it('lifts the filter for every read path, and only for the wrapper that owns the scope', async () => {
		const first = harness(new AsyncAdapter());
		const second = harness(new AsyncAdapter());
		first.store.set(...ghost);
		second.store.set(...ghost);
		const claim = staleGuild(first.state, G);

		const seen = await first.adapter.runUnfiltered(claim, async () => ({
			bulkGet: await first.adapter.bulkGet(['role.9']),
			scan: await first.adapter.scan('role.*', true),
			values: await first.adapter.values(ROLES),
			count: await first.adapter.count(ROLES),
			contains: await first.adapter.contains(ROLES, '9'),
			otherWrapper: await second.adapter.get('role.9'),
		}));

		expect(seen).toEqual({
			bulkGet: [ghost[1]],
			scan: ['role.9'],
			values: [ghost[1]],
			count: 1,
			contains: true,
			otherWrapper: null,
		});
	});

	it.each(variants)('revalidates the claim on every kind of removal over a %s adapter', async (_kind, create) => {
		const { adapter, inner, store, state } = harness(create());
		store.set(...ghost);
		const claim = staleGuild(state, G);
		state.guildAvailable(0, G, 5, { startup: false, unavailable: false });

		for (const remove of [
			() => adapter.remove('role.9'),
			() => adapter.bulkRemove(['role.9']),
			() => adapter.removeToRelationship(ROLES, '9'),
			() => adapter.removeRelationship(ROLES),
		]) {
			expect(await outcome(inner, () => adapter.runUnfiltered(claim, remove))).toBeInstanceOf(ReconciliationCancelled);
		}
		expect(store.get('role.9')).toEqual(ghost[1]);
	});

	it('removes what is left of a stale guild through Seyfert own cascade, hidden children included', async () => {
		const { adapter, store, state } = harness(new MemoryAdapter());
		const cache = new Cache(0, adapter, {}, {} as never);
		store.set(`guild.${G}`, { id: G }, ['guild', G]);
		store.set(...ghost);
		store.set(`member.${G}.5`, { id: '5' }, [`member.${G}`, '5']);
		store.set('channel.7', { id: '7', type: 0 }, [`channel.${G}`, '7']);
		store.set('message.8', { id: '8' }, ['message.7', '8']);
		store.set('overwrite.7', [{ id: 'r' }], [`overwrite.${G}`, '7']);
		const claim = staleGuild(state, G);

		// A normal caller sees none of it, so a filtered cascade would orphan every child.
		expect(await cache.roles!.keys(G)).toEqual([]);

		await adapter.runUnfiltered(claim, () => cache.guilds!.remove(G));

		expect(store.scan('*.*', true)).toEqual([]);
		expect(store.scan('*.*.*', true)).toEqual([]);
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('stops a cascade whose claim died without touching the store', async () => {
		const { adapter, store, state } = harness(new MemoryAdapter());
		const cache = new Cache(0, adapter, {}, {} as never);
		store.set(`guild.${G}`, { id: G }, ['guild', G]);
		store.set(...ghost);
		const claim = staleGuild(state, G);
		// The bot joined the guild again before the cleanup ran.
		state.guildAvailable(0, G, 5, { startup: false, unavailable: false });

		const error = await rejection(() => adapter.runUnfiltered(claim, () => cache.guilds!.remove(G)));

		expect(error).toBeInstanceOf(ReconciliationCancelled);
		expect(store.get('role.9')).toEqual(ghost[1]);
		expect(store.get(`guild.${G}`)).toEqual({ id: G });
	});
});

describe('memory coordinator sweep', () => {
	it('deletes a hidden candidate from the store', async () => {
		const { store, state, layout, binding, adapter } = harness(new AsyncAdapter());
		const cut = openGuild(state, G);
		store.set(...ghost);
		await adapter.set(...role1);

		const result = await binding.sweep([layout.target('role.9', [ROLES, '9'])!], cut);

		expect(result).toEqual({ removed: ['role.9'], failed: [] });
		expect(store.get('role.9')).toBeNull();
		expect(await adapter.get('role.1')).toEqual(role1[1]);
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('keeps a candidate hidden when its removal fails, and removes it on a later sweep', async () => {
		const inner = new AsyncAdapter();
		const { store, state, layout, binding } = harness(inner);
		const cut = openGuild(state, G);
		store.set(...ghost);
		store.set(...role2);
		const targets = [layout.target('role.9', [ROLES, '9'])!, layout.target('role.2', [ROLES, '2'])!];
		const error = new Error('remove failed');
		inner.failNext('remove', error);

		// One failed removal neither rejects the sweep nor stops the other candidates.
		expect(await binding.sweep(targets, cut)).toEqual({ removed: ['role.2'], failed: ['role.9'] });
		expect(state.visibility('role.9')).toBe('hidden-pending');
		expect(store.get('role.9')).not.toBeNull();
		expect(state.snapshot().failures).toEqual([expect.objectContaining({ kind: 'removal', cause: error })]);

		expect(await binding.sweep([targets[0]!], cut)).toEqual({ removed: ['role.9'], failed: [] });
		expect(store.get('role.9')).toBeNull();
		expect(state.snapshot().pending.deletions).toBe(0);
	});

	it('leaves a key alone when a write later than the snapshot confirmed it', () => {
		const { store, state, layout, binding, adapter } = harness(new MemoryAdapter());
		const cut = openGuild(state, G);
		state.observe(0, 3);
		adapter.set(...role1);

		expect(binding.sweep([layout.target('role.1', [ROLES, '1'])!], cut)).toEqual({ removed: [], failed: [] });
		expect(store.get('role.1')).toEqual(role1[1]);
	});

	it('rechecks the fence before each group of removals, so a write issued meanwhile survives', async () => {
		const inner = new AsyncAdapter();
		const { store, state, layout, binding, adapter } = harness(inner);
		const cut = openGuild(state, G);
		const targets = Array.from({ length: 150 }, (_, index) => {
			const id = `${1000 + index}`;
			store.set(`role.${id}`, { id }, [ROLES, id]);
			return layout.target(`role.${id}`, [ROLES, id])!;
		});
		const recreated = targets[149]!;
		const firstGroup = deferred();
		inner.gate('remove', firstGroup.promise);

		const sweeping = binding.sweep(targets, cut);
		// The role comes back through a later packet while the first group is still being removed.
		state.observe(0, 3);
		await adapter.set(recreated.key, { id: recreated.id, name: 'recreated' }, [ROLES, recreated.id]);
		firstGroup.resolve();
		const result = await sweeping;

		expect(result.removed).toHaveLength(149);
		expect(result.removed).not.toContain(recreated.key);
		expect(store.get(recreated.key)).toMatchObject({ name: 'recreated' });
		expect(await adapter.get(recreated.key)).toMatchObject({ name: 'recreated' });
		expect(inner.calls.filter(call => call === 'remove')).toHaveLength(149);
		expect(inner.calls).not.toContain('bulkRemove');
	});

	it('can claim a key again after a write to it failed', async () => {
		const inner = new AsyncAdapter();
		const { store, state, layout, binding, adapter } = harness(inner);
		const cut = openGuild(state, G);
		store.set(...ghost);
		inner.failNext('set', new Error('set failed'));
		await rejection(() => adapter.set(...ghost));

		// A leaked write attempt would shield the key from every later sweep.
		expect(await binding.sweep([layout.target('role.9', [ROLES, '9'])!], cut)).toEqual({
			removed: ['role.9'],
			failed: [],
		});
	});
});

describe('KeyLayout', () => {
	const layout = new KeyLayout(() => APPLICATION_ID);

	it.each([
		['guild record', `guild.${G}`, ['guild', G], { guildId: G, replaceable: false }],
		['role', 'role.1', [ROLES, '1'], { guildId: G, replaceable: true }],
		['voice state', `voice_state.${G}.5`, [`voice_state.${G}`, '5'], { guildId: G, replaceable: true }],
		['channel', 'channel.7', [`channel.${G}`, '7'], { guildId: G, replaceable: true }],
		['emoji', 'emoji.3', [`emoji.${G}`, '3'], { guildId: G, replaceable: true }],
		['sticker', 'sticker.3', [`sticker.${G}`, '3'], { guildId: G, replaceable: true }],
		['overwrite', 'overwrite.7', [`overwrite.${G}`, '7'], { guildId: G, replaceable: true }],
		['stage instance', 'stage_instance.7', [`stage_instance.${G}`, '7'], { guildId: G, replaceable: true }],
		['member', `member.${G}.5`, [`member.${G}`, '5'], { guildId: G, replaceable: false }],
		['presence', `presence.${G}.5`, [`presence.${G}`, '5'], { guildId: G, replaceable: false }],
		['ban', `ban.${G}.5`, [`ban.${G}`, '5'], { guildId: G, replaceable: false }],
		['user', 'user.5', ['user', '5'], { guildId: undefined, replaceable: false }],
		['message', 'message.8', ['message.7', '8'], { guildId: undefined, replaceable: false }],
		['DM channel', 'channel.5', ['channel.@me', '5'], { guildId: undefined, replaceable: true }],
		['application emoji', 'emoji.3', [`emoji.${APPLICATION_ID}`, '3'], { guildId: undefined, replaceable: true }],
	] as const)('files a %s under the right partition and policy', (_name, key, relationship, expected) => {
		expect(layout.target(key, relationship)).toEqual({ key, to: relationship[0], id: relationship[1], ...expected });
	});

	it('leaves other resources unmanaged', () => {
		expect(layout.target('cooldown.a', ['cooldown', 'a'])).toBeUndefined();
		expect(layout.manages('cooldown.a')).toBe(false);
		expect(layout.manages('guildish.1')).toBe(false);
		expect(layout.manages('guild')).toBe(true);
		expect(layout.guildRecord(`guild.${G}`)).toBe(G);
		expect(layout.guildRecord('role.1')).toBeUndefined();
	});

	it('names the channel a message relationship hangs from', () => {
		expect(layout.messageChannel('message.7')).toBe('channel.7');
		expect(layout.messageChannel('message')).toBeUndefined();
		expect(layout.messageChannel('channel.7')).toBeUndefined();
	});
});
