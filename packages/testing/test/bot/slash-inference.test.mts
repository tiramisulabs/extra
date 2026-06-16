import { describe, expect, test } from 'vitest';
import { createMockBot, type SlashOptionsOf } from '../../src/bot/bot';
import { EchoCommand, FilterCommand, GreetCommand, SlowCommand } from './_setup';

/** Compile-time assertion that the argument is assignable to `Expected`; the typed parameter does the checking. */
function expectAssignable<Expected>(_value: Expected): void {}

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

	test('the string overload still works unchanged (backward compatible)', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		const result = await bot.slash({ name: 'greet', options: { name: 'legacy' } });
		expect(result.content).toBe('Hello, legacy!');
		await bot.close();
	});
});

describe('S18 slash inference: compile-time enforcement', () => {
	test('SlashOptionsOf maps the declared record to value types', () => {
		// GreetCommand declares a required string `name`.
		const ok: SlashOptionsOf<typeof GreetCommand> = { name: 'slipher' };
		expectAssignable<{ name: string }>(ok);

		// FilterCommand: required number `count`, optional string `label`.
		const filter: SlashOptionsOf<typeof FilterCommand> = { count: 1 };
		expectAssignable<{ count: number; label?: string }>(filter);
	});

	test('wrong option value type fails to compile', async () => {
		const bot = await createMockBot({ commands: [FilterCommand, GreetCommand] });
		// @ts-expect-error count is a number; a string is rejected by the inferred bag.
		await bot.slash(FilterCommand, { options: { count: 'three' } });
		// @ts-expect-error name is a string; a number is rejected.
		await bot.slash(GreetCommand, { options: { name: 42 } });
		await bot.close();
	});

	test('required option omission fails to compile', async () => {
		const bot = await createMockBot({ commands: [FilterCommand] });
		// @ts-expect-error `count` is required and must be present.
		await bot.slash(FilterCommand, { options: { label: 'x' } });
		await bot.close();
	});

	test('unknown option key fails to compile', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		// @ts-expect-error `nope` is not a declared option on GreetCommand.
		await bot.slash(GreetCommand, { options: { name: 'slipher', nope: true } });
		await bot.close();
	});

	test('passing name in the class overload fails to compile', async () => {
		const bot = await createMockBot({ commands: [GreetCommand] });
		// @ts-expect-error name is derived from the class and is not accepted here.
		await bot.slash(GreetCommand, { name: 'greet', options: { name: 'slipher' } });
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
