import { ESLintUtils } from '@typescript-eslint/utils';
import preferTypedGroupFactory from '../src/rules/preferTypedGroup';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/prefer-typed-group');
const rule = preferTypedGroupFactory(createRule);

createTester().run('prefer-typed-group', rule, {
	valid: [
		// The typed two-argument overload — `name` is checked against the groups object.
		`import { Group, SubCommand } from 'seyfert';
@Group({ admin: { defaultDescription: 'Admin' } }, 'admin')
class S extends SubCommand {}`,
		// Same, sourced from a shared `defineGroups` object (the intended pattern).
		`import { Group, SubCommand, defineGroups } from 'seyfert';
const groups = defineGroups({ admin: { defaultDescription: 'Admin' } });
@Group(groups, 'admin')
class S extends SubCommand {}`,
		// Wrong-package guard: a local, non-seyfert `Group` is never flagged.
		`function Group(_n: string) { return (_t: unknown) => {}; }
@Group('admin')
class X {}`,
	],
	invalid: [
		{
			// Single string argument — unchecked overload.
			code: `import { Group, SubCommand } from 'seyfert';
@Group('admin')
class S extends SubCommand {}`,
			errors: [{ messageId: 'preferTypedGroup' }],
		},
		{
			// A single non-literal argument is still the unchecked overload.
			code: `import { Group, SubCommand } from 'seyfert';
const name = 'admin';
@Group(name)
class S extends SubCommand {}`,
			errors: [{ messageId: 'preferTypedGroup' }],
		},
	],
});
