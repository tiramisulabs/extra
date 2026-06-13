import { join } from 'node:path';
import { type ParseLocales } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('real bot loading', () => {
	// Seyfert's loader imports files directly; this fixture needs compiled output for decorators.
	test.todo('loads command classes from an explicit commandsDir', async () => {
		const bot = await createMockBot({
			commandsDir: join(process.cwd(), 'test/fixtures/commands'),
		});

		const result = await bot.slash({ name: 'ping' });
		expect(result.content).toBe('pong');
		await bot.close();
	});
});
