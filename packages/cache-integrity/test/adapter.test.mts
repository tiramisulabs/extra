import { type Adapter, MemoryAdapter } from 'seyfert';
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

	async bulkSet(entries: [string, any][]): Promise<void> {
		this.memory.bulkSet(entries);
	}

	async set(key: string, data: any): Promise<void> {
		this.setCalls++;
		if (this.setCalls === this.failSetAt) {
			throw new Error('set failed');
		}
		this.memory.set(key, data);
	}

	async bulkPatch(entries: [string, any][]): Promise<void> {
		this.memory.bulkPatch(entries);
	}

	async patch(key: string, data: any): Promise<void> {
		this.patchKeys.push(key);
		this.memory.patch(key, data);
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

	async bulkAddToRelationShip(data: Record<string, string[]>): Promise<void> {
		this.memory.bulkAddToRelationShip(data);
	}

	async addToRelationship(to: string, keys: string | string[]): Promise<void> {
		this.memory.addToRelationship(to, keys);
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

	override patch(key: string, data: any): void {
		super.patch(this.logical(key), data);
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
			['guild.old', { id: 'old' }],
			['guild.other', { id: 'other' }],
		]);
		inner.addToRelationship('guild', ['old', 'other']);

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
			['guild.one', { id: 'one' }],
			['guild.two', { id: 'two' }],
		]);
		adapter.bulkAddToRelationShip({ guild: ['one', 'two'] });

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
		inner.set('member.1', { id: '1', stale: true, username: 'old' });
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.patch('member.1', { id: '1', username: 'current' });
		expect(adapter.get('member.1')).toEqual({ id: '1', username: 'current' });

		adapter.patch('member.1', { nickname: 'new' });
		expect(adapter.get('member.1')).toEqual({ id: '1', nickname: 'new', username: 'current' });
	});

	it('handles hidden and visible entries in the same bulk patch', () => {
		const inner = new MemoryAdapter();
		inner.set('member.hidden', { stale: true });
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);
		adapter.set('member.visible', { current: true });

		adapter.bulkPatch([
			['member.hidden', { current: 'hidden' }],
			['member.visible', { patched: true }],
		]);

		expect(adapter.get('member.hidden')).toEqual({ current: 'hidden' });
		expect(adapter.get('member.visible')).toEqual({ current: true, patched: true });
	});

	it('preserves sequential patch semantics for duplicate bulk keys', () => {
		const inner = new MemoryAdapter();
		inner.set('member.duplicate', { stale: true });
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.bulkPatch([
			['member.duplicate', { first: true }],
			['member.duplicate', { second: true }],
		]);

		expect(adapter.get('member.duplicate')).toEqual({ first: true, second: true });
	});

	it('does not expose an old value through a current relationship', () => {
		const inner = new MemoryAdapter();
		inner.set('guild.old', { id: 'old' });
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.addToRelationship('guild', 'old');

		expect(adapter.keys('guild')).toEqual(['guild.old']);
		expect(adapter.values('guild')).toEqual([]);
	});

	it('preserves adapter-prefixed keys without losing current visibility', () => {
		const inner = new PrefixedAdapter();
		inner.set('guild.old', { id: 'old' });
		inner.addToRelationship('guild', 'old');
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.set('guild.current', { id: 'current' });
		adapter.addToRelationship('guild', 'current');

		expect(adapter.scan('guild.*', true)).toEqual(['cache:guild.current']);
		expect(adapter.keys('guild')).toEqual(['cache:guild.current']);
		expect(adapter.values('guild')).toEqual([{ id: 'current' }]);

		adapter.patch('cache:guild.current', { patched: true });
		expect(adapter.get('guild.current')).toEqual({ id: 'current', patched: true });
	});

	it('does not confuse colons inside logical keys with the verified adapter prefix', () => {
		const inner = new PrefixedAdapter();
		inner.set('tenant:item', { stale: true });
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		adapter.set('item', { current: true });

		expect(adapter.get('cache:tenant:item')).toBeNull();
		expect(adapter.get('cache:item')).toEqual({ current: true });
	});

	it('updates visibility after removals and flushes', () => {
		const adapter = new CacheIntegrityAdapter(new MemoryAdapter(), MAX_AGE);
		adapter.bulkSet([
			['guild.one', { id: 'one' }],
			['guild.two', { id: 'two' }],
		]);
		adapter.addToRelationship('guild', ['one', 'two']);

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
		adapter.set('guild.one', { id: 'one' });
		adapter.addToRelationship('guild', 'one');

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
		await expect(adapter.set('guild.failed', { id: 'failed' })).rejects.toThrow('set failed');
		expect(await adapter.get('guild.failed')).toBeNull();

		inner.failSetAt = undefined;
		await adapter.set('guild.current', { id: 'current' });
		expect(await adapter.get('guild.current')).toEqual({ id: 'current' });
	});

	it('reuses recent persisted values only through explicit key reads', () => {
		const now = Date.now();
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now);
		const inner = new MemoryAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		first.bulkSet([
			['guild.one', { id: 'one' }],
			['guild.two', { id: 'two' }],
		]);
		first.addToRelationship('guild', ['one', 'two']);

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
			['member.fresh', { id: 'fresh', preserved: true }],
			['member.expired', { id: 'expired', stale: true }],
		]);

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		second.patch('member.fresh', { patched: true });
		expect(second.get('member.fresh')).toEqual({ id: 'fresh', patched: true, preserved: true });

		dateNow.mockReturnValue(now + MAX_AGE + 1);
		try {
			second.patch('member.expired', { current: true });
			expect(second.get('member.expired')).toEqual({ current: true });
		} finally {
			dateNow.mockRestore();
		}
	});

	it('keeps a new value hidden when its freshness metadata fails', async () => {
		const inner = new AsyncAdapter();
		inner.failSetAt = 2;
		const adapter = new CacheIntegrityAdapter(inner, MAX_AGE);

		await expect(adapter.set('guild.partial', { id: 'partial' })).rejects.toThrow('set failed');
		expect(inner.memory.get('guild.partial')).toEqual({ id: 'partial' });
		expect(await adapter.get('guild.partial')).toBeNull();
	});

	it('checks persisted freshness through asynchronous adapters', async () => {
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.bulkSet([
			['guild.one', { id: 'one' }],
			['guild.two', { id: 'two' }],
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
		await first.set('guild.delayed', { id: 'delayed' });

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
		await first.set('member.fresh', { preserved: true });
		inner.memory.set('member.legacy', { stale: true });

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		await second.bulkPatch([
			['member.fresh', { patched: true }],
			['member.legacy', { current: true }],
		]);

		expect(await second.get('member.fresh')).toEqual({ patched: true, preserved: true });
		expect(await second.get('member.legacy')).toEqual({ current: true });
	});

	it('replaces a value when freshness metadata outlives the data', async () => {
		const inner = new AsyncAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		await first.set('member.orphaned', { stale: true });
		inner.memory.remove('member.orphaned');

		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		await second.patch('member.orphaned', { current: true });

		expect(inner.patchKeys).not.toContain('member.orphaned');
		expect(await second.get('member.orphaned')).toEqual({ current: true });
	});

	it('removes freshness metadata with its value', () => {
		const inner = new MemoryAdapter();
		const first = new CacheIntegrityAdapter(inner, MAX_AGE);
		first.set('guild.removed', { id: 'removed' });
		first.remove('guild.removed');

		inner.set('guild.removed', { id: 'bypass' });
		const second = new CacheIntegrityAdapter(inner, MAX_AGE);
		expect(second.get('guild.removed')).toBeNull();
	});
});
