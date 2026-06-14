import { type ParseLocales } from 'seyfert';
import { InteractionResponseType } from 'seyfert/lib/types';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { ReportMessage, ReportUser, SearchCommand } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface DefaultLocale extends ParseLocales<typeof englishLang> {}
}

describe('autocomplete and context menus', () => {
	test('autocomplete returns the responded choices', async () => {
		const bot = await createMockBot({ commands: [SearchCommand] });
		const result = await bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' });
		expect(result.choices).toEqual([{ name: 'result:sey', value: 'sey' }]);
		await bot.close();
	});

	test('userMenu resolves the target user', async () => {
		const bot = await createMockBot({ commands: [ReportUser] });
		const target = apiUser({ id: '42', username: 'spammer' });
		const result = await bot.userMenu({ name: 'Report User', target });
		expect(result.reply?.body).toMatchObject({
			type: InteractionResponseType.ChannelMessageWithSource,
			data: { content: 'Reported spammer' },
		});
		await bot.close();
	});

	test('context menu dispatchers require a matching command type', async () => {
		const bot = await createMockBot({ commands: [ReportUser, ReportMessage] });

		expect(() => bot.userMenu({ name: 'Report Message' })).toThrow(/userMenu: command "Report Message"/);
		expect(() => bot.messageMenu({ name: 'Report User' })).toThrow(/messageMenu: command "Report User"/);

		await bot.close();
	});
});
