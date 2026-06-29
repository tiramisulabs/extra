import { ESLintUtils } from '@typescript-eslint/utils';
import noHangingMiddlewareFactory from '../src/rules/noHangingMiddleware';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/no-hanging-middleware');
const rule = noHangingMiddlewareFactory(createRule);

const mw = (body: string) => `import { createMiddleware } from 'seyfert';\nexport const m = ${body};`;

createTester().run('no-hanging-middleware', rule, {
	valid: [
		// Unconditional next.
		mw(`createMiddleware(({ next }) => { next(); })`),
		// Every branch advances (return stop / next).
		mw(`createMiddleware(({ next, stop }) => { if (Math.random() > 0.5) return stop('e'); next(); })`),
		// if/else, both advance.
		mw(`createMiddleware(({ next, stop }) => { if (Math.random() > 0.5) next(); else stop('e'); })`),
		// Expression-body arrow with member call.
		mw(`createMiddleware(m => m.next())`),
		// Async: advances after await.
		mw(`createMiddleware(async ({ next }) => { await Promise.resolve(); next(); })`),
		// switch with every case + default advancing.
		mw(`createMiddleware(({ next, stop }) => {
	switch (Math.floor(Math.random() * 2)) {
		case 0:
			return next();
		default:
			return stop('e');
	}
})`),
		// throw branch is exempt (does not hang); the other branch advances.
		mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) throw new Error('x'); next(); })`),
		// Not seyfert's createMiddleware -> not analysed.
		`function createMiddleware(cb: (c: { next: () => void }) => void) { return cb; }
const m = createMiddleware(() => {});`,
	],
	invalid: [
		// if without else: the false path hangs.
		{
			code: mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) next(); })`),
			errors: [{ messageId: 'mayHang' }],
		},
		// Empty body never advances.
		{ code: mw(`createMiddleware(() => {})`), errors: [{ messageId: 'mayHang' }] },
		// Early return without advancing.
		{
			code: mw(`createMiddleware(({ next }) => { if (Math.random() > 0.5) return; next(); })`),
			errors: [{ messageId: 'mayHang' }],
		},
		// `pass` no longer advances the pipeline -> hangs.
		{ code: mw(`createMiddleware(({ pass }) => { pass(); })`), errors: [{ messageId: 'mayHang' }] },
		// switch without default: the unmatched path falls through.
		{
			code: mw(`createMiddleware(({ next }) => {
	switch (Math.floor(Math.random() * 2)) {
		case 0:
			next();
			break;
	}
})`),
			errors: [{ messageId: 'mayHang' }],
		},
	],
});
