import { ESLintUtils } from '@typescript-eslint/utils';
import { describe, expect, it } from 'vitest';
import groupExistsFactory from '../src/rules/groupExists';
import { lintProject } from './_disk';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/group-exists');
const rule = groupExistsFactory(createRule);

// ---- Mode A (explicit `@Options([Sub])`), single-file via the rule tester ----
createTester().run('group-exists', rule, {
	valid: [
		// Groups declared through seyfert's `defineGroups` helper.
		`import { Command, SubCommand, Declare, Options, Group, Groups, defineGroups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups(defineGroups({ mod: { defaultDescription: 'm' } })) @Options([Sub]) class C extends Command {}`,
		// Groups merged from a shared object via spread.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
const SHARED = { shared: { defaultDescription: 's' } };
@Declare({ name: 's', description: 'd' }) @Group('shared') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ ...SHARED, extra: { defaultDescription: 'e' } }) @Options([Sub]) class C extends Command {}`,
		// Aliases supplied through a const array reference.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
const MOD_ALIASES = ['m'];
@Declare({ name: 's', description: 'd' }) @Group('m') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm', aliases: MOD_ALIASES } }) @Options([Sub]) class C extends Command {}`,
		// Shorthand group entry.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
const mod = { defaultDescription: 'm' };
@Declare({ name: 's', description: 'd' }) @Group('mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod }) @Options([Sub]) class C extends Command {}`,
		// Subcommand's group is declared on the command.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Command {}`,
		// Group referenced by one of its declared aliases.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('m') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm', aliases: ['m'] } }) @Options([Sub]) class C extends Command {}`,
		// Groups declared with the typed `@GroupsT`.
		`import { Command, SubCommand, Declare, Options, Group, GroupsT } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @GroupsT({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Command {}`,
		// A subcommand with no `@Group` is a top-level subcommand — nothing to check.
		`import { Command, SubCommand, Declare, Options, Groups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Command {}`,
		// Non-literal group name -> unknown, never guessed.
		`import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
const g = 'whatever';
@Declare({ name: 's', description: 'd' }) @Group(g) class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Command {}`,
		// `@Options` record (plain options, not subcommands) is left alone.
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
@Declare({ name: 'c', description: 'd' }) @Options({ q: createStringOption({ description: 'q' }) }) class C extends Command {}`,
		// Wrong-package guard: a command that does not extend seyfert's `Command` is skipped.
		`import { SubCommand, Declare, Group, Groups, Options } from 'seyfert';
class Local {}
@Declare({ name: 's', description: 'd' }) @Group('typo') class Sub extends SubCommand {}
@Groups({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Local {}`,
	],
	invalid: [
		// Group not declared on the command.
		{
			code: `import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('typo') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options([Sub]) class C extends Command {}`,
			errors: [{ messageId: 'unknownGroup', data: { group: 'typo' } }],
		},
		// Subcommand uses a group but the command declares none.
		{
			code: `import { Command, SubCommand, Declare, Options, Group } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group('mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Options([Sub]) class C extends Command {}`,
			errors: [{ messageId: 'unknownGroup', data: { group: 'mod' } }],
		},
		// Typed `@Group(defs, 'mod')` whose name is valid against `defs` but NOT against the
		// parent command's groups — a real inconsistency TS cannot see.
		{
			code: `import { Command, SubCommand, Declare, Options, Group, Groups } from 'seyfert';
@Declare({ name: 's', description: 'd' }) @Group({ mod: { defaultDescription: 'm' } }, 'mod') class Sub extends SubCommand {}
@Declare({ name: 'c', description: 'd' }) @Groups({ admin: { defaultDescription: 'a' } }) @Options([Sub]) class C extends Command {}`,
			errors: [{ messageId: 'unknownGroup', data: { group: 'mod' } }],
		},
	],
});

// ---- Mode A cross-file + Mode B (`@AutoLoad`), via the disk harness ----
const sub = (name: string, group: string, extra = '') =>
	`import { SubCommand, Declare, Group } from 'seyfert';
@Declare({ name: '${name}', description: 'd' }) @Group('${group}')${extra}
export default class ${name[0].toUpperCase()}${name.slice(1)} extends SubCommand {}`;

describe('group-exists (disk fixtures)', () => {
	it('does not crash on a circular `@Options` reference', async () => {
		const results = await lintProject(
			{
				'commands/a.ts': "import { b } from './b';\nexport const a: unknown[] = b;",
				'commands/b.ts': "import { a } from './a';\nexport const b: unknown[] = a;",
				'commands/cmd.ts': `import { Command, Declare, Groups, Options } from 'seyfert';
import { a } from './a';
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options(a as never)
export default class C extends Command {}`,
			},
			{ 'seyfert/group-exists': 'error' },
		);
		const cmd = results.find(r => r.file.endsWith('cmd.ts'));
		expect(cmd?.messages.filter(m => m.ruleId === 'seyfert/group-exists')).toHaveLength(0);
	});

	it('Mode A: flags a cross-file subcommand whose group is undeclared', async () => {
		const results = await lintProject(
			{
				'commands/sub.ts': sub('ban', 'typo'),
				'commands/cmd.ts': `import { Command, Declare, Options, Groups } from 'seyfert';
import Ban from './sub';
@Declare({ name: 'c', description: 'd' }) @Groups({ mod: { defaultDescription: 'm' } }) @Options([Ban])
export default class C extends Command {}`,
			},
			{ 'seyfert/group-exists': 'error' },
		);
		const cmd = results.find(r => r.file.endsWith('cmd.ts'));
		expect(cmd?.messages.map(m => m.messageId)).toContain('unknownGroup');
	});

	it('Mode B: @AutoLoad flags a sibling subcommand with an undeclared group', async () => {
		const results = await lintProject(
			{
				'commands/admin/admin.ts': `import { Command, Declare, AutoLoad, Groups } from 'seyfert';
@Declare({ name: 'admin', description: 'd' }) @AutoLoad() @Groups({ mod: { defaultDescription: 'm' } })
export default class Admin extends Command {}`,
				'commands/admin/ban.ts': sub('ban', 'mod'),
				'commands/admin/kick.ts': sub('kick', 'typo'),
			},
			{ 'seyfert/group-exists': 'error' },
		);
		const parent = results.find(r => r.file.endsWith('admin.ts'));
		const messages = parent?.messages ?? [];
		expect(messages.map(m => m.messageId)).toContain('unknownGroupAutoload');
		// Names the offending subcommand + group, not the valid one.
		expect(messages.some(m => m.message.includes('typo') && m.message.includes('Kick'))).toBe(true);
		expect(messages.some(m => m.message.includes('Ban'))).toBe(false);
	});

	it('Mode B: @AutoLoad is clean when every subcommand group is declared', async () => {
		const results = await lintProject(
			{
				'commands/admin/admin.ts': `import { Command, Declare, AutoLoad, Groups } from 'seyfert';
@Declare({ name: 'admin', description: 'd' }) @AutoLoad() @Groups({ mod: { defaultDescription: 'm' }, sys: { defaultDescription: 's' } })
export default class Admin extends Command {}`,
				'commands/admin/ban.ts': sub('ban', 'mod'),
				'commands/admin/sync.ts': sub('sync', 'sys'),
			},
			{ 'seyfert/group-exists': 'error' },
		);
		const parent = results.find(r => r.file.endsWith('admin.ts'));
		expect(parent?.messages ?? []).toHaveLength(0);
	});

	it('Mode B: @AutoLoad scans nested directories (matches the loader)', async () => {
		const results = await lintProject(
			{
				'commands/admin/admin.ts': `import { Command, Declare, AutoLoad, Groups } from 'seyfert';
@Declare({ name: 'admin', description: 'd' }) @AutoLoad() @Groups({ mod: { defaultDescription: 'm' } })
export default class Admin extends Command {}`,
				'commands/admin/sub/kick.ts': sub('kick', 'typo'),
			},
			{ 'seyfert/group-exists': 'error' },
		);
		const parent = results.find(r => r.file.endsWith('admin.ts'));
		expect(parent?.messages.map(m => m.messageId)).toContain('unknownGroupAutoload');
	});
});
