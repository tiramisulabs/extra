import { ESLintUtils } from '@typescript-eslint/utils';
import decoratorOnCommandFactory from '../src/rules/decoratorOnCommand';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/decorator-on-command');
const rule = decoratorOnCommandFactory(createRule);

const code = (body: string) =>
	`import { Command, SubCommand, ComponentCommand, ModalCommand, Declare, Options, Middlewares, Locales, LocalesT, createStringOption } from 'seyfert';\n${body}`;
const onCommandOnly = (body: string) => ({ code: code(body), errors: [{ messageId: 'onCommandOnly' as const }] });
const onCommandOrComponentOnly = (body: string) => ({
	code: code(body),
	errors: [{ messageId: 'onCommandOrComponentOnly' as const }],
});

// Minimal concrete bodies: `ComponentCommand`/`ModalCommand` are abstract.
const BUTTON = `componentType = 'Button' as const; run() {}`;
const MODAL = 'run() {}';

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
		// `@Middlewares` also belongs on components: seyfert's component handler runs
		// the `middlewares` of `ComponentCommand`/`ModalCommand` subclasses.
		code(`@Middlewares([]) class B extends ComponentCommand { ${BUTTON} }`),
		code(`@Middlewares([]) class M extends ModalCommand { ${MODAL} }`),
		code(
			`abstract class BaseButton extends ComponentCommand {}\n@Middlewares([]) class B extends BaseButton { ${BUTTON} }`,
		),
		// A generic class between the decorated class and the seyfert base.
		code(
			`abstract class Paged<T> extends ComponentCommand { page?: T }\nabstract class QueuePage extends Paged<string> {}\n@Middlewares([]) class Next extends QueuePage { ${BUTTON} }`,
		),
		code(
			`abstract class Guild<T> extends Command { state?: T }\nabstract class Music extends Guild<string> {}\n@Declare({ name: 'skip', description: 'd' }) @Middlewares([]) class Skip extends Music {}`,
		),
		// A base produced by a generic class factory.
		code(
			`function button<const Id extends string>(customId: Id) {\n\tabstract class Base extends ComponentCommand { override customId = customId; }\n\treturn Base;\n}\n@Middlewares([]) class Pause extends button('pause') { ${BUTTON} }`,
		),
		// Exact repro from tiramisulabs/extra#49.
		`import { ComponentCommand, type GuildComponentContext, Middlewares } from 'seyfert';

@Middlewares(['checkNodes', 'checkPlayer'])
export default class PauseTrackComponent extends ComponentCommand {
	override componentType = 'Button' as const;
	override customId = 'player-pauseTrack';

	async run(ctx: GuildComponentContext<typeof this.componentType>): Promise<void> {}
}`,
		// Wrong-package guard: a local, non-seyfert `Declare` must NOT be checked.
		`function Declare(_options: unknown) { return (_target: unknown) => {}; }
@Declare({ name: 'x', description: 'd' }) class X {}`,
	],
	invalid: [
		// Command decorators on a class with no command base.
		onCommandOnly(`@Declare({ name: 'x', description: 'd' }) class X {}`),
		onCommandOnly(`@Options({ a: createStringOption({ description: 'a' }) }) class X {}`),
		onCommandOrComponentOnly(`@Middlewares([]) class X {}`),
		onCommandOnly(`@Locales({}) class X {}`),
		onCommandOnly(`@LocalesT() class X {}`),
		// Extending a non-seyfert class is still not a command base.
		{
			code: code(`class Local {}\n@Declare({ name: 'x', description: 'd' }) class X extends Local {}`),
			errors: [{ messageId: 'onCommandOnly' }],
		},
		// Only `@Middlewares` is accepted on components; the rest stay command-only.
		onCommandOnly(`@Declare({ name: 'x', description: 'd' }) class B extends ComponentCommand { ${BUTTON} }`),
		onCommandOnly(
			`@Options({ a: createStringOption({ description: 'a' }) }) class M extends ModalCommand { ${MODAL} }`,
		),
		onCommandOnly(`@Locales({}) class B extends ComponentCommand { ${BUTTON} }`),
		onCommandOnly(`@LocalesT() class M extends ModalCommand { ${MODAL} }`),
		// Stacked on a component: only the command-only decorator is reported.
		onCommandOnly(
			`@Declare({ name: 'x', description: 'd' }) @Middlewares([]) class B extends ComponentCommand { ${BUTTON} }`,
		),
		// Wrong-package guard: a local class named `ComponentCommand` is not seyfert's.
		{
			code: `import { Middlewares } from 'seyfert';\nclass ComponentCommand {}\n@Middlewares([]) class X extends ComponentCommand {}`,
			errors: [{ messageId: 'onCommandOrComponentOnly' }],
		},
		// A generic chain that never reaches a seyfert base is still reported.
		onCommandOrComponentOnly(
			`class Local<T> { value?: T }\nclass Mid extends Local<string> {}\n@Middlewares([]) class X extends Mid {}`,
		),
	],
});
