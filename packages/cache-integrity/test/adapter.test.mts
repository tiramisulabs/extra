import { type Adapter, type AdapterEntry, type AdapterRelationship, MemoryAdapter } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';
import { CacheIntegrityAdapter } from '../src/adapter';

const MAX_AGE = 60_000;

class AsyncAdapter implements Adapter {
	readonly isAsync = true;
	readonly memory = new MemoryAdapter();
	failSetAt: number | undefined;
	getGate: Promise<void> | undefined;
	patchKeys: string[] = [];
	setCalls = 0;

	async start(): Promise<void> {}

	async scan(query: string, keys?: false): Promise<any[]>;
	async scan(query: string, keys: true): Promise<string[]>;
	async scan(query: string, keys?: boolean): Promise<any[]> {
		return this.memory.scan(query, keys as true);
	}

	async bulkGet(keys: string[]): Promise<any[]> {
		return this.memory.bulkGet(keys);
	}

	async get(key: string): Promise<any | null> {
		await this.getGate;
		return this.memory.get(key);
	}

	async bulkSet(entries: AdapterEntry[]): Promise<void> {
		this.memory.bulkSet(entries);
	}

	async set(key: string, data: any, relationship: AdapterRelationship): Promise<void> {
		this.setCalls++;
		if (this.setCalls === this.failSetAt) {
			throw new Error('set failed');
		}
		this.memory.set(key, data, relationship);
	}

	async bulkPatch(entries: AdapterEntry[]): Promise<void> {
		this.memory.bulkPatch(entries);
	}

	async patch(key: string, data: any, relationship: AdapterRelationship): Promise<void> {
		this.patchKeys.push(key);
		this.memory.patch(key, data, relationship);
	}

	async values(to: string): Promise<any[]> {
		return this.memory.values(to);
	}

	async keys(to: string): Promise<string[]> {
		return this.memory.keys(to);
	}

	async count(to: string): Promise<number> {
		return this.memory.count(to);
	}

	async bulkRemove(keys: string[]): Promise<void> {
		this.memory.bulkRemove(keys);
	}

	async remove(key: string): Promise<void> {
		this.memory.remove(key);
	}

	async flush(): Promise<void> {
		this.memory.flush();
	}

	async contains(to: string, key: string): Promise<boolean> {
		return this.memory.contains(to, key);
	}

	async getToRelationship(to: string): Promise<string[]> {
		return this.memory.getToRelationship(to);
	}

	async removeToRelationship(to: string, keys: string | string[]): Promise<void> {
		this.memory.removeToRelationship(to, keys);
	}

	async removeRelationship(to: string | string[]): Promise<void> {
		this.memory.removeRelationship(to);
	}
}

class PrefixedAdapter extends MemoryAdapter<unknown> {
	readonly prefix = 'cache:';

	buildKey(key: string): string {
		return key.startsWith(this.prefix) ? key : this.prefix + key;
	}

	override scan(query: string, keys?: false): any[];
	override scan(query: string, keys: true): string[];
	override scan(query: string, keys?: boolean): any[] {
		return keys ? super.scan(query, true).map(key => this.prefix + key) : super.scan(query);
	}

	override bulkGet(keys: string[]): unknown[] {
		return super.bulkGet(keys.map(key => this.logical(key)));
	}

	override get(key: string): unknown {
		return super.get(this.logical(key));
	}

	override patch(key: string, data: any, relationship: AdapterRelationship): void {
		super.patch(this.logical(key), data, relationship);
	}

	override keys(to: string): string[] {
		return super.keys(to).map(key => this.prefix + key);
	}

	private logical(key: string): string {
		return key.startsWith(this.prefix) ? key.slice(this.prefix.length) : key;
	}
}

describe('CacheIntegrityAdapter', () => {
	it('hides values and relationships written before this generation', () => {
		const inner = new MemoryAdapter();
		inner.bulkSet([
			['guild.old', { id: 'old' }, ['guild', 'old']],
			['guild.other', { id: 'other' }, ['guild', 'other']],
		]);

		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		expect(adapter.get('guild.old')).toBeNull();
		expect(adapter.bulkGet(['guild.old', 'guild.other'])).toEqual([]);
		expect(adapter.scan('guild.*')).toEqual([]);
		expect(adapter.scan('guild.*', true)).toEqual([]);
		expect(adapter.getToRelationship('guild')).toEqual([]);
		expect(adapter.keys('guild')).toEqual([]);
		expect(adapter.values('guild')).toEqual([]);
		expect(adapter.count('guild')).toBe(0);
		expect(adapter.contains('guild', 'old')).toBe(false);
	});

	it('exposes successful current-generation writes through every read path', () => {
		const adapter = new CacheIntegrityAdapter(new MemoryAdapter(), MAX_AGE);

		adapter.bulkSet([
			['guild.one', { id: 'one' }, ['guild', 'one']],
			['guild.two', { id: 'two' }, ['guild', 'two']],
		]);

		expect(adapter.get('guild.one')).toEqual({ id: 'one' });
		expect(adapter.bulkGet(['guild.two', 'guild.one'])).toEqual([{ id: 'two' }, { id: 'one' }]);
		expect(adapter.scan('guild.*', true)).toEqual(['guild.one', 'guild.two']);
		expect(adapter.getToRelationship('guild')).toEqual(['one', 'two']);
		expect(adapter.keys('guild')).toEqual(['guild.one', 'guild.two']);
		expect(adapter.values('guild')).toEqual([{ id: 'one' }, { id: 'two' }]);
		expect(adapter.count('guild')).toBe(2);
		expect(adapter.contains('guild', 'one')).toBe(true);
	});

	it('replaces a hidden value on its first patch, then applies normal patch semantics', () => {
		const inner = new MemoryAdapter();
		inner.set('member.1', { id: '1', stale: true, username: 'old' }, ['member', '1']);
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.patch('member.1', { id: '1', username: 'current' }, ['member', '1']);
		expect(adapter.get('member.1')).toEqual({ id: '1', username: 'current' });

		adapter.patch('member.1', { nickname: 'new' }, ['member', '1']);
		expect(adapter.get('member.1')).toEqual({ id: '1', nickname: 'new', username: 'current' });
	});

	it('handles hidden and visible entries in the same bulk patch', () => {
		const inner = new MemoryAdapter();
		inner.set('member.hidden', { stale: true }, ['member', 'hidden']);
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		adapter.set('member.visible', { current: true }, ['member', 'visible']);

		adapter.bulkPatch([
			['member.hidden', { current: 'hidden' }, ['member', 'hidden']],
			['member.visible', { patched: true }, ['member', 'visible']],
		]);

		expect(adapter.get('member.hidden')).toEqual({ current: 'hidden' });
		expect(adapter.get('member.visible')).toEqual({ current: true, patched: true });
	});

	it('preserves sequential patch semantics for duplicate bulk keys', () => {
		const inner = new MemoryAdapter();
		inner.set('member.duplicate', { stale: true }, ['member', 'duplicate']);
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.bulkPatch([
			['member.duplicate', { first: true }, ['member', 'duplicate']],
			['member.duplicate', { second: true }, ['member', 'duplicate']],
		]);

		expect(adapter.get('member.duplicate')).toEqual({ first: true, second: true });
	});

	it('keeps message storage keys independent of relationship scope', () => {
		const adapter = new CacheIntegrityAdapter(new MemoryAdapter(), MAX_AGE);
		adapter.set('message.123', { id: '123' }, ['message.456', '123']);
		expect(adapter.keys('message.456')).toEqual(['message.123']);
		expect(adapter.values('message.456')).toEqual([{ id: '123' }]);
		adapter.removeToRelationship('message.456', '123');
		expect(adapter.get('message.123')).toBeNull();
		expect(adapter.count('message.456')).toBe(0);
	});

	it('preserves adapter-prefixed keys without losing current visibility', () => {
		const inner = new PrefixedAdapter();
		inner.set('guild.old', { id: 'old' }, ['guild', 'old']);
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.set('guild.current', { id: 'current' }, ['guild', 'current']);

		expect(adapter.scan('guild.*', true)).toEqual(['cache:guild.current']);
		expect(adapter.keys('guild')).toEqual(['cache:guild.current']);
		expect(adapter.values('guild')).toEqual([{ id: 'current' }]);

		adapter.patch('cache:guild.current', { patched: true }, ['guild', 'current']);
		expect(adapter.get('guild.current')).toEqual({ id: 'current', patched: true });
	});

	it('does not confuse colons inside logical keys with the verified adapter prefix', () => {
		const inner = new PrefixedAdapter();
		inner.set('user.tenant:item', { stale: true }, ['user', 'tenant:item']);
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.set('user.item', { current: true }, ['user', 'item']);

		expect(adapter.get('cache:user.tenant:item')).toBeNull();
		expect(adapter.get('cache:user.item')).toEqual({ current: true });
	});

	it('updates visibility after removals and flushes', () => {
		const adapter = new CacheIntegrityAdapter(new MemoryAdapter(), MAX_AGE);
		adapter.bulkSet([
			['guild.one', { id: 'one' }, ['guild', 'one']],
			['guild.two', { id: 'two' }, ['guild', 'two']],
		]);

		adapter.remove('guild.one');
		adapter.removeToRelationship('guild', 'one');
		expect(adapter.get('guild.one')).toBeNull();
		expect(adapter.getToRelationship('guild')).toEqual(['two']);

		adapter.flush();
		expect(adapter.get('guild.two')).toBeNull();
		expect(adapter.getToRelationship('guild')).toEqual([]);
	});

	it('does not report a current relationship after the backing adapter loses it', () => {
		const inner = new MemoryAdapter();
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		adapter.set('guild.one', { id: 'one' }, ['guild', 'one']);

		inner.removeToRelationship('guild', 'one');

		expect(adapter.getToRelationship('guild')).toEqual([]);
		expect(adapter.keys('guild')).toEqual([]);
		expect(adapter.count('guild')).toBe(0);
		expect(adapter.contains('guild', 'one')).toBe(false);
	});

	it('does not expose an asynchronous write until it succeeds', async () => {
		const inner = new AsyncAdapter();
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		const hiddenGet = adapter.get('guild.hidden');
		const hiddenRelationship = adapter.getToRelationship('guild');
		const hiddenContains = adapter.contains('guild', 'hidden');
		expect(hiddenGet).toBeInstanceOf(Promise);
		expect(hiddenRelationship).toBeInstanceOf(Promise);
		expect(hiddenContains).toBeInstanceOf(Promise);
		expect(adapter.bulkPatch([])).toBeInstanceOf(Promise);
		expect(await hiddenGet).toBeNull();
		expect(await hiddenRelationship).toEqual([]);
		expect(await hiddenContains).toBe(false);

		inner.failSetAt = 1;
		await expect(adapter.set('guild.failed', { id: 'failed' }, ['guild', 'failed'])).rejects.toThrow('set failed');
		expect(await adapter.get('guild.failed')).toBeNull();

		inner.failSetAt = undefined;
		await adapter.set('guild.current', { id: 'current' }, ['guild', 'current']);
		expect(await adapter.get('guild.current')).toEqual({ id: 'current' });
	});

	it('reuses recent persisted values only through explicit key reads', () => {
		const now = Date.now();
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
		const inner = new MemoryAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		first.bulkSet([
			['guild.one', { id: 'one' }, ['guild', 'one']],
			['guild.two', { id: 'two' }, ['guild', 'two']],
		]);

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		expect(second.get('guild.one')).toEqual({ id: 'one' });
		expect(second.bulkGet(['guild.two', 'guild.one'])).toEqual([{ id: 'two' }, { id: 'one' }]);
		expect(second.scan('guild.*')).toEqual([]);
		expect(second.values('guild')).toEqual([]);
		expect(second.getToRelationship('guild')).toEqual([]);

		dateNow.mockReturnValue(now + MAX_AGE + 1);
		try {
			expect(second.get('guild.one')).toBeNull();
			expect(second.bulkGet(['guild.one', 'guild.two'])).toEqual([]);
		} finally {
			dateNow.mockRestore();
		}
	});

	it('patches recent persisted values and replaces expired ones', () => {
		const now = Date.now();
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
		const inner = new MemoryAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		first.bulkSet([
			['member.fresh', { id: 'fresh', preserved: true }, ['member', 'fresh']],
			['member.expired', { id: 'expired', stale: true }, ['member', 'expired']],
		]);

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		second.patch('member.fresh', { patched: true }, ['member', 'fresh']);
		expect(second.get('member.fresh')).toEqual({ id: 'fresh', patched: true, preserved: true });

		dateNow.mockReturnValue(now + MAX_AGE + 1);
		try {
			second.patch('member.expired', { current: true }, ['member', 'expired']);
			expect(second.get('member.expired')).toEqual({ current: true });
		} finally {
			dateNow.mockRestore();
		}
	});

	it('keeps a new value hidden when its freshness metadata fails', async () => {
		const inner = new AsyncAdapter();
		inner.failSetAt = 2;
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		await expect(adapter.set('guild.partial', { id: 'partial' }, ['guild', 'partial'])).rejects.toThrow('set failed');
		expect(inner.memory.get('guild.partial')).toEqual({ id: 'partial' });
		expect(await adapter.get('guild.partial')).toBeNull();
	});

	it('checks persisted freshness through asynchronous adapters', async () => {
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.bulkSet([
			['guild.one', { id: 'one' }, ['guild', 'one']],
			['guild.two', { id: 'two' }, ['guild', 'two']],
		]);

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		expect(await second.get('guild.one')).toEqual({ id: 'one' });
		expect(await second.bulkGet(['guild.two', 'guild.one'])).toEqual([{ id: 'two' }, { id: 'one' }]);
	});

	it('evaluates freshness after asynchronous metadata reads settle', async () => {
		const now = Date.now();
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.set('guild.delayed', { id: 'delayed' }, ['guild', 'delayed']);

		let release!: () => void;
		inner.getGate = new Promise<void>(resolve => {
			release = resolve;
		});
		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		const read = second.get('guild.delayed');
		dateNow.mockReturnValue(now + MAX_AGE + 1);
		release();

		try {
			expect(await read).toBeNull();
		} finally {
			dateNow.mockRestore();
		}
	});

	it('classifies asynchronous bulk patches by persisted freshness', async () => {
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.set('member.fresh', { preserved: true }, ['member', 'fresh']);
		inner.memory.set('member.legacy', { stale: true }, ['member', 'legacy']);

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		await second.bulkPatch([
			['member.fresh', { patched: true }, ['member', 'fresh']],
			['member.legacy', { current: true }, ['member', 'legacy']],
		]);

		expect(await second.get('member.fresh')).toEqual({ patched: true, preserved: true });
		expect(await second.get('member.legacy')).toEqual({ current: true });
	});

	it('replaces a value when freshness metadata outlives the data', async () => {
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.set('member.orphaned', { stale: true }, ['member', 'orphaned']);
		inner.memory.remove('member.orphaned');

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		await second.patch('member.orphaned', { current: true }, ['member', 'orphaned']);

		expect(inner.patchKeys).not.toContain('member.orphaned');
		expect(await second.get('member.orphaned')).toEqual({ current: true });
	});

	it('removes freshness metadata with its value', () => {
		const inner = new MemoryAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		first.set('guild.removed', { id: 'removed' }, ['guild', 'removed']);
		first.remove('guild.removed');

		inner.set('guild.removed', { id: 'bypass' }, ['guild', 'removed']);
		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		expect(second.get('guild.removed')).toBeNull();
	});
	it.each([
		'bulkSet',
		'bulkPatch',
		'bulkRemove',
	] as const)('%s settles failures, in-flight entries, and later chunks', async method => {
		const inner = new AsyncAdapter();
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		const entries: AdapterEntry[] = Array.from({ length: 101 }, (_, i) => [
			`user.${i}`,
			{ id: String(i), current: true },
			['user', String(i)],
		]);
		if (method !== 'bulkSet') await adapter.bulkSet(entries);
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
		const { promise: failed, resolve: markFailed } = Promise.withResolvers<void>();
		const intercept = async (key: string) => {
			if (key === 'user.0') {
				markFailed();
				throw new Error('entry failed');
			}
			if (key === 'user.99') {
				markStarted();
				await gate;
			}
		};
		const set = inner.set.bind(inner);
		const patch = inner.patch.bind(inner);
		const remove = inner.remove.bind(inner);
		inner.set = async (key, data, relationship) => {
			await intercept(key);
			await set(key, data, relationship);
		};
		inner.patch = async (key, data, relationship) => {
			await intercept(key);
			await patch(key, data, relationship);
		};
		inner.remove = async key => {
			await intercept(key);
			await remove(key);
		};
		let settled = false;
		const operation = (
			method === 'bulkRemove' ? adapter.bulkRemove(entries.map(([key]) => key)) : adapter[method](entries)
		) as Promise<void>;
		const result = operation
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		try {
			await Promise.all([started, failed]);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(settled).toBe(false);
			release();
			const error = await result;
			expect(error).toBeInstanceOf(AggregateError);
			expect(error.errors).toHaveLength(1);
			if (method === 'bulkRemove') {
				expect(await adapter.keys('user')).toEqual(['user.0']);
				expect(await adapter.get('user.100')).toBeNull();
			} else {
				expect(await adapter.get('user.100')).toEqual({ id: '100', current: true });
				expect(await adapter.contains('user', '99')).toBe(true);
				expect(await adapter.count('user')).toBe(method === 'bulkSet' ? 100 : 101);
			}
		} finally {
			release();
			await result;
		}
	});

	it('keeps both the value and relationship hidden if a new entry metadata write fails', async () => {
		const inner = new AsyncAdapter();
		inner.failSetAt = 2;
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		await expect(adapter.set('message.123', { id: '123' }, ['message.456', '123'])).rejects.toThrow();
		expect(inner.memory.keys('message.456')).toEqual(['message.123']);
		expect(await adapter.keys('message.456')).toEqual([]);
		expect(await adapter.contains('message.456', '123')).toBe(false);
		expect(await adapter.get('message.123')).toBeNull();
	});

	it('keeps current-process writes visible beyond maxAge without promoting warm reads', () => {
		const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
		try {
			const inner = new MemoryAdapter();
			const first = new CacheIntegrityAdapter(inner, MAX_AGE);
			first.set('user.1', { id: '1' }, ['user', '1']);
			const second = new CacheIntegrityAdapter(inner, MAX_AGE);
			expect(second.get('user.1')).toEqual({ id: '1' });
			clock.mockReturnValue(100_000 + MAX_AGE + 1);
			expect(first.get('user.1')).toEqual({ id: '1' });
			expect(second.get('user.1')).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});
});
