import { ESLintUtils } from '@typescript-eslint/utils';
import { describe, expect, it } from 'vitest';
import requireDeclareFactory from '../src/rules/requireDeclare';
import { lintProject } from './_disk';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/require-declare');
const rule = requireDeclareFactory(createRule);

createTester().run('require-declare', rule, {
	valid: [
		// Decorated command — the happy path.
		`import { Command, Declare } from 'seyfert';
@Declare({ name: 'ping', description: 'Pong' })
class Ping extends Command {}`,
		// Decorated subcommand.
		`import { SubCommand, Declare } from 'seyfert';
@Declare({ name: 'sub', description: 'Sub' })
class Sub extends SubCommand {}`,
		// Plain classes that are not seyfert commands.
		'class Foo {}',
		'class Bar extends Array {}',
		// Abstract intermediate base is exempt (not itself a registered command).
		`import { Command } from 'seyfert';
abstract class Base extends Command {}`,
		// Wrong-package guard: a local class named `Command` must NOT trigger.
		`class Command {}
class Mine extends Command {}`,
	],
	invalid: [
		{
			code: `import { Command } from 'seyfert';
class Ping extends Command {}`,
			errors: [{ messageId: 'missingDeclare' }],
		},
		{
			code: `import { SubCommand } from 'seyfert';
class Sub extends SubCommand {}`,
			errors: [{ messageId: 'missingDeclare' }],
		},
		{
			// Transitive: extends a user subclass of a seyfert command.
			code: `import { Command } from 'seyfert';
abstract class Base extends Command {}
class Ping extends Base {}`,
			errors: [{ messageId: 'missingDeclare' }],
		},
	],
});

describe('require-declare (disk fixtures)', () => {
	it('flags a command missing @Declare across multiple files', async () => {
		const results = await lintProject(
			{
				'base.ts': `import { Command } from 'seyfert';
export abstract class Base extends Command {}`,
				'ping.ts': `import { Base } from './base';
export class Ping extends Base {}`,
			},
			{ 'seyfert/require-declare': 'error' },
		);

		const ping = results.find(result => result.file.endsWith('ping.ts'));
		expect(ping?.messages.map(message => message.messageId)).toContain('missingDeclare');
	});

	it('accepts a decorated command', async () => {
		const results = await lintProject(
			{
				'ping.ts': `import { Command, Declare } from 'seyfert';
@Declare({ name: 'ping', description: 'Pong' })
export class Ping extends Command {}`,
			},
			{ 'seyfert/require-declare': 'error' },
		);

		expect(results[0]?.messages).toHaveLength(0);
	});
});
