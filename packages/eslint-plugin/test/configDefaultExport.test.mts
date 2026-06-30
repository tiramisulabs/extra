import { ESLintUtils } from '@typescript-eslint/utils';
import configDefaultExportFactory from '../src/rules/configDefaultExport';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/config-default-export');
const rule = configDefaultExportFactory(createRule);

createTester().run('config-default-export', rule, {
	valid: [
		// Angle-bracket type assertion on the default export — unwrapped, still valid.
		`import { config } from 'seyfert';
export default <unknown>config.bot({ token: 't', locations: { base: 'src' } });`,
		// Idiomatic: the bot config IS the default export.
		`import { config } from 'seyfert';
export default config.bot({ token: 't', locations: { base: 'src' } });`,
		// Idiomatic: the http config IS the default export (publicKey + applicationId required).
		`import { config } from 'seyfert';
export default config.http({ token: 't', publicKey: 'p', applicationId: 'a', locations: { base: 'src' } });`,
		// Wrong-package guard: a local, non-seyfert `config` is never flagged.
		`const config = { bot(_d: unknown) {}, http(_d: unknown) {} };
config.bot({ token: 't' });`,
		// Soundness: a same-named method on an unrelated object is ignored.
		`const thing = { bot() {} };
thing.bot();`,
		// `as` / `satisfies` wrapping the default export are unwrapped — still valid.
		`import { config } from 'seyfert';
export default config.bot({ token: 't', locations: { base: 'src' } }) as unknown;`,
		`import { config } from 'seyfert';
export default config.http({ token: 't', publicKey: 'p', applicationId: 'a', locations: { base: 'src' } }) satisfies unknown;`,
	],
	invalid: [
		{
			// Bare statement — result is discarded, not exported.
			code: `import { config } from 'seyfert';
config.bot({ token: 't', locations: { base: 'src' } });`,
			errors: [{ messageId: 'mustDefaultExport', data: { method: 'bot' } }],
		},
		{
			// Assigned to a const — indirection is conservatively flagged.
			code: `import { config } from 'seyfert';
const c = config.bot({ token: 't', locations: { base: 'src' } });`,
			errors: [{ messageId: 'mustDefaultExport', data: { method: 'bot' } }],
		},
		{
			// http variant in a bare statement.
			code: `import { config } from 'seyfert';
config.http({ token: 't', publicKey: 'p', applicationId: 'a', locations: { base: 'src' } });`,
			errors: [{ messageId: 'mustDefaultExport', data: { method: 'http' } }],
		},
	],
});
