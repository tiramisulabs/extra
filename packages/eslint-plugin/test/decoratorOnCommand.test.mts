import { ESLintUtils } from '@typescript-eslint/utils';
import decoratorOnCommandFactory from '../src/rules/decoratorOnCommand';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/decorator-on-command');
const rule = decoratorOnCommandFactory(createRule);

const code = (body: string) =>
	`import { Command, SubCommand, Declare, Options, Middlewares, Locales, LocalesT, createStringOption } from 'seyfert';\n${body}`;
const onCommandOnly = (body: string) => ({ code: code(body), errors: [{ messageId: 'onCommandOnly' as const }] });

createTester().run('decorator-on-command', rule, {
	valid: [
		// Each command decorator on a class that extends `Command`.
		code(`@Declare({ name: 'c', description: 'd' }) class C extends Command {}`),
		code(`@Options({ a: createStringOption({ description: 'a' }) }) class C extends Command {}`),
		code(`@Middlewares([]) class C extends Command {}`),
		code(`@Locales({}) class C extends Command {}`),
		code(`@LocalesT() class C extends Command {}`),
		// `SubCommand` is also a command base.
		code(`@Declare({ name: 's', description: 'd' }) class S extends SubCommand {}`),
		// Transitive base resolved through the type checker.
		code(`class Base extends Command {}\n@Declare({ name: 'c', description: 'd' }) class C extends Base {}`),
		// Stacked command decorators on a Command -> no reports.
		code(
			`@Declare({ name: 'c', description: 'd' }) @Options({ a: createStringOption({ description: 'a' }) }) class C extends Command {}`,
		),
		// Wrong-package guard: a local, non-seyfert `Declare` must NOT be checked.
		`function Declare(_options: unknown) { return (_target: unknown) => {}; }
@Declare({ name: 'x', description: 'd' }) class X {}`,
	],
	invalid: [
		// Command decorators on a class with no command base.
		onCommandOnly(`@Declare({ name: 'x', description: 'd' }) class X {}`),
		onCommandOnly(`@Options({ a: createStringOption({ description: 'a' }) }) class X {}`),
		onCommandOnly(`@Middlewares([]) class X {}`),
		onCommandOnly(`@Locales({}) class X {}`),
		onCommandOnly(`@LocalesT() class X {}`),
		// Extending a non-seyfert class is still not a command base.
		{
			code: code(`class Local {}\n@Declare({ name: 'x', description: 'd' }) class X extends Local {}`),
			errors: [{ messageId: 'onCommandOnly' }],
		},
	],
});
