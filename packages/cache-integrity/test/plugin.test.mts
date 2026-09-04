import { createMockBot } from '@slipher/testing';
import { type Adapter, Client, definePlugins, MemoryAdapter, WorkerAdapter } from 'seyfert';
import { describe, expect, it } from 'vitest';
import { CacheIntegrityAdapter } from '../src/adapter';
import { cacheIntegrity } from '../src/plugin';

const options = { maxAge: 60_000 };

function createClient(adapter: Adapter): Client {
	const client = new Client({ plugins: definePlugins(cacheIntegrity(options)) });
	client.setServices({ cache: { adapter } });
	return client;
}

describe('cacheIntegrity', () => {
	it('wraps the configured adapter during setup and restores it during teardown', async () => {
		const original = new MemoryAdapter();
		const client = createClient(original);
		const bot = await createMockBot({ client });

		expect(client.cache.adapter).toBeInstanceOf(CacheIntegrityAdapter);
		expect((client.cache.adapter as CacheIntegrityAdapter).inner).toBe(original);
		expect((client.cache.adapter as CacheIntegrityAdapter).maxAge).toBe(options.maxAge);

		await bot.close();
		expect(client.cache.adapter).toBe(original);
	});

	it('does not overwrite an adapter installed after its own wrapper', async () => {
		const client = createClient(new MemoryAdapter());
		const bot = await createMockBot({ client });

		const replacement = new MemoryAdapter();
		client.cache.adapter = replacement;
		await bot.close();

		expect(client.cache.adapter).toBe(replacement);
	});

	it('rejects WorkerAdapter during mock client startup', async () => {
		const original = new WorkerAdapter({} as never);
		const client = createClient(original);

		await expect(createMockBot({ client })).rejects.toThrow('cannot wrap WorkerAdapter');
		expect(client.cache.adapter).toBe(original);
	});

	it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('rejects invalid maxAge %s', maxAge => {
		expect(() => cacheIntegrity({ maxAge })).toThrow('maxAge must be a positive finite number');
	});
});
