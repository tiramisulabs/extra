import { describe, expect, test } from 'vitest';
import {
	type AutocompleteResult,
	createMockBot,
	DISPATCHER_VERBS,
	type DispatchResult,
	type MockBot,
	type SayResult,
} from '../../src/bot/bot';
import { apiMessage, apiUser } from '../../src/bot/payloads';
import { sampleCommands, sampleComponents } from './_setup';

type DispatcherVerb = (typeof DISPATCHER_VERBS)[number];
type MatrixResult = DispatchResult | AutocompleteResult | SayResult;

interface MatrixCase {
	verb: DispatcherVerb;
	name: string;
	run(bot: MockBot): PromiseLike<MatrixResult>;
	check(result: MatrixResult): void;
}

const cases: MatrixCase[] = [
	{
		verb: 'slash',
		name: 'slash -> content',
		run: bot => bot.slash({ name: 'greet', options: { name: 'x' } }),
		check: result => expect(result.content).toBe('Hello, x!'),
	},
	{
		verb: 'clickButton',
		name: 'button -> content',
		run: bot => bot.clickButton('confirm'),
		check: result => expect(result.content).toBe('Confirmed!'),
	},
	{
		verb: 'selectMenu',
		name: 'select menu -> values',
		run: bot => bot.selectMenu('pick', ['red']),
		check: result => expect(result.content).toBe('Picked red'),
	},
	{
		verb: 'fillModal',
		name: 'modal -> reply',
		run: bot => bot.fillModal('feedback', { rating: '5' }),
		check: result => expect(result.content).toBe('Thanks!'),
	},
	{
		verb: 'say',
		name: 'prefix message -> reply',
		run: bot => bot.say('!echo -text hello'),
		check: result => expect(result.content).toBe('echo: hello'),
	},
	{
		verb: 'autocomplete',
		name: 'autocomplete -> choices',
		run: bot => bot.autocomplete({ name: 'search', focused: 'query', value: 'sey' }),
		check: result => {
			expect('choices' in result ? result.choices : undefined).toEqual([{ name: 'result:sey', value: 'sey' }]);
		},
	},
	{
		verb: 'userMenu',
		name: 'user context menu -> target user',
		run: bot => bot.userMenu({ name: 'Report User', target: apiUser({ id: '42', username: 'spammer' }) }),
		check: result => expect(result.content).toBe('Reported spammer'),
	},
	{
		verb: 'messageMenu',
		name: 'message context menu -> target message',
		run: bot => bot.messageMenu({ name: 'Report Message', target: apiMessage({ id: 'msg-42' }) }),
		check: result => expect(result.content).toBe('Reported message msg-42'),
	},
	{
		verb: 'entryPoint',
		name: 'entry point -> reply',
		run: bot => bot.entryPoint({ name: 'launch' }),
		check: result => expect(result.content).toBe('launched'),
	},
];

describe('capability matrix - every interaction type, one place', () => {
	for (const c of cases) {
		test(c.name, async () => {
			await using bot = await createMockBot({
				commands: sampleCommands,
				components: sampleComponents,
				prefixes: ['!'],
			});

			c.check(await c.run(bot));
		});
	}

	test('every dispatcher verb has a matrix row', () => {
		const covered = new Set(cases.map(c => c.verb));
		for (const verb of DISPATCHER_VERBS) expect(covered).toContain(verb);
	});
});
