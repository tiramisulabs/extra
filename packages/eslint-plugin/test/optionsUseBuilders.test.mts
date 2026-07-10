import { ESLintUtils } from '@typescript-eslint/utils';
import { describe, expect, it } from 'vitest';
import optionsUseBuildersFactory from '../src/rules/optionsUseBuilders';
import { lintProject } from './_disk';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/options-use-builders');
const rule = optionsUseBuildersFactory(createRule);

createTester().run('options-use-builders', rule, {
	valid: [
		// Inline, created with a seyfert builder.
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
@Declare({ name: 'c', description: 'c' })
@Options({ query: createStringOption({ description: 'q' }) })
class C extends Command {}`,
		// Same-file const, created with a seyfert builder — resolved through the variable.
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
const opts = { query: createStringOption({ description: 'q' }) };
@Declare({ name: 'c', description: 'c' })
@Options(opts)
class C extends Command {}`,
		// Array form (subcommands) is left untouched.
		`import { Command, SubCommand, Declare, Options } from 'seyfert';
@Declare({ name: 's', description: 's' })
class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'c' })
@Options([Sub])
class C extends Command {}`,
		// Wrong-package guard: a local, non-seyfert `Options` must NOT be touched.
		`function Options(_options: unknown) {
	return (_target: unknown) => {};
}
@Options({ query: { description: 'q' } })
class C {}`,
	],
	invalid: [
		{
			// Inline raw object.
			code: `import { Command, Declare, Options } from 'seyfert';
@Declare({ name: 'c', description: 'c' })
@Options({ query: { description: 'q' } })
class C extends Command {}`,
			errors: [{ messageId: 'useBuilder' }],
		},
		{
			// Same-file const with a raw object — resolved through the variable.
			code: `import { Command, Declare, Options } from 'seyfert';
const opts = { query: { description: 'q' } };
@Declare({ name: 'c', description: 'c' })
@Options(opts)
class C extends Command {}`,
			errors: [{ messageId: 'useBuilder' }],
		},
		{
			// "Only seyfert" guarantee: a LOCAL function named createStringOption is rejected.
			code: `import { Command, Declare, Options } from 'seyfert';
function createStringOption(data: { description: string }) {
	return data;
}
const opts = { query: createStringOption({ description: 'q' }) };
@Declare({ name: 'c', description: 'c' })
@Options(opts)
class C extends Command {}`,
			errors: [{ messageId: 'useBuilder' }],
		},
	],
});

describe('options-use-builders (disk fixtures)', () => {
	it('resolves a same-file const and flags a raw option', async () => {
		const results = await lintProject(
			{
				'cmd.ts': `import { Command, Declare, Options } from 'seyfert';
const opts = { query: { description: 'q' } };
@Declare({ name: 'c', description: 'c' })
@Options(opts)
export class C extends Command {}`,
			},
			{ 'seyfert/options-use-builders': 'error' },
		);

		expect(results[0]?.messages.map(message => message.messageId)).toContain('useBuilder');
	});

	it('flags a raw option in a record imported from another file', async () => {
		const results = await lintProject(
			{
				'opts.ts': `import { createStringOption } from 'seyfert';
export const opts = { good: createStringOption({ description: 'g' }), bad: { description: 'b' } };`,
				'cmd.ts': `import { Command, Declare, Options } from 'seyfert';
import { opts } from './opts';
@Declare({ name: 'c', description: 'c' })
@Options(opts)
export class C extends Command {}`,
			},
			{ 'seyfert/options-use-builders': 'error' },
		);

		const cmd = results.find(result => result.file.endsWith('cmd.ts'));
		expect(cmd?.messages.map(message => message.messageId)).toContain('useBuilder');
	});

	it('accepts an imported record where every option is a seyfert builder', async () => {
		const results = await lintProject(
			{
				'opts.ts': `import { createStringOption, createNumberOption } from 'seyfert';
export const opts = { a: createStringOption({ description: 'a' }), b: createNumberOption({ description: 'b' }) };`,
				'cmd.ts': `import { Command, Declare, Options } from 'seyfert';
import { opts } from './opts';
@Declare({ name: 'c', description: 'c' })
@Options(opts)
export class C extends Command {}`,
			},
			{ 'seyfert/options-use-builders': 'error' },
		);

		const cmd = results.find(result => result.file.endsWith('cmd.ts'));
		expect(cmd?.messages).toHaveLength(0);
	});
});
