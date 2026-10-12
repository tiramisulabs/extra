import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { EchoCommand, FilterCommand, GreetCommand, SlowCommand } from './_setup';

describe('S18 slash class-inference', () => {
	test('infers the option bag from the class and dispatches with no cast', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		// name is derived from the class; options.name is inferred to a required string.
		const result = await bot.slash(GreetCommand, { options: { name: 'slipher' } });
		expect(result.content).toBe('Hello, slipher!');
		await bot.close();
	});

	test('infers required-integer + optional-string option types', async () => {
		const bot = await createMockBot({ commands: [FilterCommand] });
		const result = await bot.slash(FilterCommand, { options: { count: 3, label: 'rows' } });
		expect(result.content).toBe('rows:3');
		// label is optional, so it may be omitted.
		const onlyCount = await bot.slash(FilterCommand, { options: { count: 7 } });
		expect(onlyCount.content).toBe('items:7');
		await bot.close();
	});

	test('the class overload composes with the actor', async () => {
		const bot = await createMockBot({ commands: [EchoCommand] });
		const actor = bot.actor({});
		const result = await actor.slash(EchoCommand, { options: { text: 'hi' } });
		expect(result.content).toBe('echo: hi');
		await bot.close();
	});

	test('object-form slash dispatch is the concise raw-by-name path', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'object' } });
		expect(result.content).toBe('Hello, object!');
		await bot.close();
	});

	test('a class without a typed run degrades to an empty bag, not an error', async () => {
		const bot = await createMockBot({ commands: [SlowCommand] });
		// SlowCommand's run is `CommandContext` (no generic): options degrades to an empty record.
		const result = await bot.slash(SlowCommand, {});
		expect(result.deferred).toBe(true);
		// An empty options bag is accepted on the degraded class.
		const again = await bot.slash(SlowCommand, { options: {} });
		expect(again.deferred).toBe(true);
		await bot.close();
	});
});
