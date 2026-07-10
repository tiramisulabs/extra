import { ESLintUtils } from '@typescript-eslint/utils';
import i18nResolveWithGetFactory from '../src/rules/i18nResolveWithGet';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/i18n-resolve-with-get');
const rule = i18nResolveWithGetFactory(createRule);

// A real seyfert command whose `ctx.t` is typed through a `SeyfertRegistry`
// augmentation, so `ctx.t.greeting` resolves to a locale proxy (has `.get()`).
const code = (body: string) =>
	`import { Command, Declare, type CommandContext } from 'seyfert';
const en = { greeting: 'hi', nested: { deep: 'x' } };
declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof en;
	}
}
@Declare({ name: 'c', description: 'd' })
class C extends Command {
	run(ctx: CommandContext) {
${body}
	}
}`;

const invalid = (body: string, count = 1) => ({
	code: code(body),
	errors: Array.from({ length: count }, () => ({ messageId: 'callGet' as const })),
});

createTester().run('i18n-resolve-with-get', rule, {
	valid: [
		// Proxy resolved with `.get()` inside a template literal.
		code('\t\tconst s = `${ctx.t.greeting.get()}`;\n\t\treturn s;'),
		// Proxy resolved with `.get()` inside a string concatenation.
		code("\t\treturn 'x' + ctx.t.greeting.get();"),
		// Stored proxy resolved later — the bare assignment is not a string context.
		code('\t\tconst proxy = ctx.t.greeting;\n\t\treturn proxy.get();'),
		// A plain string in a template literal is not a proxy.
		code('\t\tconst hi = ctx.t.greeting.get();\n\t\treturn `${hi}`;'),
		// SOUNDNESS: a non-seyfert look-alike object with its own `get` method is
		// NOT flagged, in either a template literal or a concatenation — its `get`
		// is declared in this file, not in `seyfert/lib`.
		`const o = { greeting: { get() { return 'x'; } } };
export const s = \`\${o.greeting}\`;
export const t = 'x' + o.greeting;`,
	],
	invalid: [
		// Proxy used directly inside a template literal.
		invalid('\t\tconst s = `${ctx.t.greeting}`;\n\t\treturn s;'),
		// Proxy used directly in a string concatenation (right operand).
		invalid("\t\treturn 'x' + ctx.t.greeting;"),
		// Proxy used directly in a string concatenation (left operand).
		invalid("\t\treturn ctx.t.greeting + ' world';"),
		// A nested (record) proxy is still a proxy.
		invalid('\t\tconst s = `${ctx.t.nested}`;\n\t\treturn s;'),
		// Two proxies in one template literal -> one report each.
		invalid('\t\tconst s = `${ctx.t.greeting} ${ctx.t.nested}`;\n\t\treturn s;', 2),
	],
});
