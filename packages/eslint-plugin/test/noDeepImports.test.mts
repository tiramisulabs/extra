import { ESLintUtils } from '@typescript-eslint/utils';
import { describe, expect, it } from 'vitest';
import noDeepImportsFactory from '../src/rules/noDeepImports';
import { lintProject } from './_disk';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/no-deep-imports');
const rule = noDeepImportsFactory(createRule);

createTester().run('no-deep-imports', rule, {
	valid: [
		// Deep-only symbol (not re-exported from root) — must NOT be flagged.
		"import { CommandHandler } from 'seyfert/lib/commands/handler';",
		// Already importing from the package root.
		"import { Command } from 'seyfert';",
		// Unrelated package.
		"import { readFileSync } from 'node:fs';",
	],
	invalid: [
		{
			// Single root-available symbol → rewrite the whole source.
			code: "import { Command } from 'seyfert/lib/commands/applications/chat';",
			output: "import { Command } from 'seyfert';",
			errors: [{ messageId: 'preferRoot' }],
		},
		{
			// A default specifier is present → report but do not auto-rewrite.
			code: "import def, { Command } from 'seyfert/lib/commands/applications/chat';",
			output: null,
			errors: [{ messageId: 'preferRoot' }],
		},
		{
			// The bare `seyfert/lib` barrel resolves to the same file as the root → must be flagged.
			code: "import { AutoLoad } from 'seyfert/lib';",
			output: "import { AutoLoad } from 'seyfert';",
			errors: [{ messageId: 'preferRoot' }],
		},
	],
});

describe('no-deep-imports (disk fixtures)', () => {
	it('flags a root-available symbol imported from a deep path', async () => {
		const results = await lintProject(
			{ 'cmd.ts': "import { Declare } from 'seyfert/lib/commands/decorators';\nexport const x = Declare;" },
			{ 'seyfert/no-deep-imports': 'error' },
		);
		expect(results[0]?.messages.map(message => message.messageId)).toContain('preferRoot');
	});
});
