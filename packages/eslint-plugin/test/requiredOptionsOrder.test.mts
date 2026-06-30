import { ESLintUtils } from '@typescript-eslint/utils';
import requiredOptionsOrderFactory from '../src/rules/requiredOptionsOrder';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/required-options-order');
const rule = requiredOptionsOrderFactory(createRule);

const code = (body: string) =>
	`import { Command, SubCommand, Declare, Options, createStringOption } from 'seyfert';\n${body}`;

createTester().run('required-options-order', rule, {
	valid: [
		// `required` via ES2015 shorthand (const = true): both options required -> valid order.
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
const required = true;
@Declare({ name: 'c', description: 'c' })
@Options({ a: createStringOption({ description: 'a', required }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`,
		// `required` carried by a spread fragment: unknown, never assumed optional.
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
const base = { description: 'a', required: true } as const;
@Declare({ name: 'c', description: 'c' })
@Options({ a: createStringOption({ ...base }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`,
		// Required option first, optional after — the correct order.
		code(`@Declare({ name: 'c', description: 'c' })
@Options({ a: createStringOption({ description: 'a', required: true }), b: createStringOption({ description: 'b', required: false }) })
class C extends Command {}`),
		// Every option required.
		code(`@Options({ a: createStringOption({ description: 'a', required: true }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`),
		// Every option optional (no `required` key at all).
		code(`@Options({ a: createStringOption({ description: 'a' }), b: createStringOption({ description: 'b' }) })
class C extends Command {}`),
		// A single option can never be out of order.
		code(`@Options({ a: createStringOption({ description: 'a', required: true }) })
class C extends Command {}`),
		// A non-literal `required` is unknown -> it is NOT treated as an optional
		// boundary, so a following `required: true` must not be flagged. (Soundness.)
		code(`const flag = Math.random() > 0.5;
@Options({ a: createStringOption({ description: 'a', required: flag }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`),
		// The array (subcommands) form of @Options is left untouched.
		code(`@Declare({ name: 's', description: 's' })
class Sub extends SubCommand {}
@Options([Sub])
class C extends Command {}`),
		// Wrong-package guard: a local, non-seyfert `Options` must NOT be inspected,
		// even though it places a required option after an optional one. (Soundness.)
		`function Options(_options: unknown) {
	return (_target: unknown) => {};
}
@Options({ a: { description: 'a', required: false }, b: { description: 'b', required: true } })
class C {}`,
	],
	invalid: [
		{
			// Optional (no `required` key) followed by a required option.
			code: code(`@Options({ a: createStringOption({ description: 'a' }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`),
			errors: [{ messageId: 'requiredAfterOptional' }],
		},
		{
			// Explicit `required: false` followed by `required: true`.
			code: code(`@Options({ a: createStringOption({ description: 'a', required: false }), b: createStringOption({ description: 'b', required: true }) })
class C extends Command {}`),
			errors: [{ messageId: 'requiredAfterOptional' }],
		},
		{
			// Same-file const record resolved through the variable.
			code: code(`const o = { a: createStringOption({ description: 'a' }), b: createStringOption({ description: 'b', required: true }) };
@Options(o)
class C extends Command {}`),
			errors: [{ messageId: 'requiredAfterOptional' }],
		},
	],
});
