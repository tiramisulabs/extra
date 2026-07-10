import { ESLintUtils } from '@typescript-eslint/utils';
import decoratorTargetFactory from '../src/rules/decoratorTarget';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/decorator-target');
const rule = decoratorTargetFactory(createRule);

const code = (body: string) =>
	`import { Command, SubCommand, Group, Groups, GroupsT, AutoLoad, Declare } from 'seyfert';\n${body}`;
const wrong = (body: string) => ({ code: code(body), errors: [{ messageId: 'wrongTarget' as const }] });

createTester().run('decorator-target', rule, {
	valid: [
		// @Group on a SubCommand.
		code(`@Group('g') class S extends SubCommand {}`),
		// @Groups / @GroupsT / @AutoLoad on a Command.
		code(`@Groups({}) class C extends Command {}`),
		code(`@GroupsT({}) class C extends Command {}`),
		code(`@AutoLoad() class C extends Command {}`),
		// Several command decorators stacked on a Command.
		code(`@AutoLoad() @Groups({}) @Declare({ name: 'c', description: 'd' }) class C extends Command {}`),
		// @Group + @Declare on a SubCommand.
		code(`@Declare({ name: 's', description: 'd' }) @Group('g') class S extends SubCommand {}`),
		// Transitive bases.
		code(`class Base extends SubCommand {}\n@Group('g') class S extends Base {}`),
		code(`class Base extends Command {}\n@AutoLoad() class C extends Base {}`),
		// Wrong-package guard: a local, non-seyfert `Group` must NOT be checked.
		`function Group(_n: string) { return (_t: unknown) => {}; }
@Group('g') class X {}`,
		// A decorator this rule doesn't constrain (e.g. @Declare) is ignored.
		code(`@Declare({ name: 'c', description: 'd' }) class C extends Command {}`),
	],
	invalid: [
		// @Group on the wrong base.
		wrong(`@Group('g') class C extends Command {}`),
		wrong(`@Group('g') class X {}`),
		// @Groups / @GroupsT on the wrong base.
		wrong(`@Groups({}) class S extends SubCommand {}`),
		wrong(`@Groups({}) class X {}`),
		wrong(`@GroupsT({}) class S extends SubCommand {}`),
		// @AutoLoad on the wrong base.
		wrong(`@AutoLoad() class S extends SubCommand {}`),
		wrong(`@AutoLoad() class X {}`),
		// Multiple misplaced decorators on one class -> one report each.
		{
			code: code(`@Group('g') @AutoLoad() class X {}`),
			errors: [{ messageId: 'wrongTarget' }, { messageId: 'wrongTarget' }],
		},
	],
});
