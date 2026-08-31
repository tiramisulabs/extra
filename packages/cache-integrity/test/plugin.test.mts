import { type Adapter, MemoryAdapter, WorkerAdapter } from 'seyfert';
import { describe, expect, it } from 'vitest';
import { ProcessGenerationAdapter } from '../src/adapter';
import { cacheIntegrity } from '../src/plugin';

describe('cacheIntegrity', () => {
	it('wraps the configured adapter during setup and restores it during teardown', async () => {
		const original = new MemoryAdapter();
		const client: { cache: { adapter: Adapter } } = { cache: { adapter: original } };
		const plugin = cacheIntegrity();

		await plugin.setup?.(client as never);
		expect(client.cache.adapter).toBeInstanceOf(ProcessGenerationAdapter);
		expect((client.cache.adapter as ProcessGenerationAdapter).inner).toBe(original);

		await plugin.teardown?.(client as never);
		expect(client.cache.adapter).toBe(original);
	});

	it('does not overwrite an adapter installed after its own wrapper', async () => {
		const client: { cache: { adapter: Adapter } } = { cache: { adapter: new MemoryAdapter() } };
		const plugin = cacheIntegrity();
		await plugin.setup?.(client as never);

		const replacement = new MemoryAdapter();
		client.cache.adapter = replacement;
		await plugin.teardown?.(client as never);

		expect(client.cache.adapter).toBe(replacement);
	});

	it('rejects WorkerAdapter before replacing it', () => {
		const original = new WorkerAdapter({} as never);
		const client: { cache: { adapter: Adapter } } = { cache: { adapter: original } };
		const plugin = cacheIntegrity();

		expect(() => plugin.setup?.(client as never)).toThrow('cannot wrap WorkerAdapter');
		expect(client.cache.adapter).toBe(original);
	});
});
