import { Command, type CommandContext, Declare, type ParseLocales } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('i18n', () => {
	@Declare({ name: 'hello', description: 'Localized greeting' })
	class HelloCommand extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: ctx.t.get().greeting });
		}
	}

	test('replies use the dispatching locale', async () => {
		const bot = await createMockBot({
			commands: [HelloCommand],
			langs: {
				'en-US': englishLang,
				'es-ES': { greeting: '¡Hola!' },
			},
			defaultLang: 'en-US',
		});

		const en = await bot.slash({ name: 'hello' });
		expect(en.reply?.body).toMatchObject({ data: { content: 'Hello!' } });

		const es = await bot.slash({ name: 'hello', locale: 'es-ES' });
		expect(es.reply?.body).toMatchObject({ data: { content: '¡Hola!' } });

		const fr = await bot.slash({ name: 'hello', locale: 'fr' });
		expect(fr.reply?.body).toMatchObject({ data: { content: 'Hello!' } });
		await bot.close();
	});
});
