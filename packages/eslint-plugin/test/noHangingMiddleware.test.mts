import { ESLintUtils } from '@typescript-eslint/utils';
import noHangingMiddlewareFactory from '../src/rules/noHangingMiddleware';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/no-hanging-middleware');
const rule = noHangingMiddlewareFactory(createRule);

const mw = (body: string) => `import { createMiddleware } from 'seyfert';\nexport const m = ${body};`;
// Same, with a declarations/types preamble so a condition can be given a precise type.
const mwd = (decls: string, body: string) =>
	`import { createMiddleware } from 'seyfert';\n${decls}\nexport const m = ${body};`;

// `if (<cond>) { next(); }` with no else — valid only when <cond> is provably truthy.
const ifCond = (cond: string) => mw(`createMiddleware(({ next }) => { if (${cond}) { next(); } })`);
const ifCondD = (decls: string, cond: string) =>
	mwd(decls, `createMiddleware(({ next }) => { if (${cond}) { next(); } })`);
const hang = (code: string) => ({ code, errors: [{ messageId: 'mayHang' as const }] });

createTester().run('no-hanging-middleware', rule, {
	valid: [
		// --- control flow (no constants) ---
		mw(`createMiddleware(({ next }) => { next(); })`),
		mw(`createMiddleware(({ next, stop }) => { if (Math.random() > 0.5) return stop('e'); next(); })`),
		mw(`createMiddleware(({ next, stop }) => { if (Math.random() > 0.5) next(); else stop('e'); })`),
		mw(`createMiddleware(m => m.next())`),
		mw(`createMiddleware(async ({ next }) => { await Promise.resolve(); next(); })`),
		mw(`createMiddleware(({ next, stop }) => {
	switch (Math.floor(Math.random() * 2)) {
		case 0:
			return next();
		default:
			return stop('e');
	}
})`),
		mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) throw new Error('x'); next(); })`),
		`function createMiddleware(cb: (c: { next: () => void }) => void) { return cb; }
const m = createMiddleware(() => {});`,

		// --- always-truthy conditions (type-aware): the consequent always runs ---
		// booleans
		ifCond('true'),
		mw(`createMiddleware(({ next }) => { if (true) next(); })`),
		ifCondD('declare const b: true;', 'b'),
		// numbers
		ifCond('1'),
		ifCond('42'),
		ifCond('-1'),
		ifCondD('declare const n: 5;', 'n'),
		// bigint
		ifCond('1n'),
		// strings
		ifCond("'go'"),
		ifCondD("declare const s: 'lit';", 's'),
		// objects
		ifCond('{}'),
		ifCondD('declare const o: { a: number };', 'o'),
		// arrays
		ifCond('[]'),
		ifCondD('declare const arr: number[];', 'arr'),
		// functions
		ifCond('() => {}'),
		ifCond('function () {}'),
		ifCondD('declare const fn: () => void;', 'fn'),
		// classes
		ifCond('class {}'),
		ifCondD('class C {}', 'C'),
		ifCondD('class C {}', 'new C()'),
		ifCondD('class C {} declare const c: C;', 'c'),

		// --- always-falsy conditions: the ELSE branch always runs ---
		mw(`createMiddleware(({ next }) => { if (false) {} else { next(); } })`),
		mw(`createMiddleware(({ stop }) => { if ('') {} else { stop('e'); } })`),
		mw(`createMiddleware(({ next }) => { if (0) {} else { next(); } })`),
		mwd('declare const u: undefined;', `createMiddleware(({ next }) => { if (u) {} else { next(); } })`),
	],
	invalid: [
		// --- real hangs (non-constant control flow) ---
		hang(mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) next(); })`)),
		hang(mw(`createMiddleware(() => {})`)),
		hang(mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) return; next(); })`)),
		hang(mw(`createMiddleware(({ pass }) => { pass(); })`)),
		hang(
			mw(`createMiddleware(({ next }) => {
	switch (Math.floor(Math.random() * 2)) {
		case 0:
			next();
			break;
	}
})`),
		),

		// --- always-falsy conditions, no else: the consequent never runs -> hangs ---
		hang(ifCond('false')),
		hang(ifCond('0')),
		hang(ifCond('0n')),
		hang(ifCond("''")),
		hang(ifCond('null')),
		hang(ifCondD('declare const u: undefined;', 'u')),

		// --- undeterminable types: could be falsy -> must NOT be suppressed ---
		hang(ifCondD('declare const b: boolean;', 'b')),
		hang(ifCondD('declare const s: string;', 's')),
		hang(ifCondD('declare const n: number;', 'n')),
		hang(ifCondD('declare const o: { a: number } | null;', 'o')),
		hang(ifCondD("declare const u: 'a' | '';", 'u')),

		// --- constant-true condition, but the taken branch still doesn't advance ---
		hang(mw(`createMiddleware(({ next }) => { if (true) { return; } next(); })`)),
		hang(mw(`createMiddleware(({ next }) => { if (true) {} })`)),
	],
});
