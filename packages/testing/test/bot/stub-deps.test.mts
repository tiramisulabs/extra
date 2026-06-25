import { describe, expect, test, vi } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { BalanceCommand } from '../fixtures/balance-command';
import * as externalService from '../fixtures/external-service';

// Loading a command from `dist` keeps it out of the runner's module graph, so `vi.mock`/`vi.spyOn` can't reach
// its dependencies — hence the require.cache surgery. Importing the command class from source and passing it to
// `createMockBot({ commands: [...] })` keeps it (and its deps) in the graph, so stubbing works with no compiled
// build and no cache surgery.
describe('stubbing a command dependency (no dist, no require.cache surgery)', () => {
	test('vi.spyOn on the imported dep reaches the command run', async () => {
		const spy = vi.spyOn(externalService, 'fetchBalance').mockReturnValue(999);

		const bot = await createMockBot({ commands: [BalanceCommand] });
		const result = await bot.slash({ name: 'balance' });

		expect(result.content).toBe('balance: 999');
		expect(spy).toHaveBeenCalledOnce();
		await bot.close();
		spy.mockRestore();
	});

	test('the real dependency runs when left unstubbed', async () => {
		const bot = await createMockBot({ commands: [BalanceCommand] });
		await expect(bot.slash({ name: 'balance' })).rejects.toThrow(/must be stubbed/);
		await bot.close();
	});
});
