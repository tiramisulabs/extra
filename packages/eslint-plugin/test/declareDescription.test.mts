import { ESLintUtils } from '@typescript-eslint/utils';
import declareDescriptionFactory from '../src/rules/declareDescription';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/declare-description');
const rule = declareDescriptionFactory(createRule);

// A 101-character literal, embedded verbatim into the type-checked inline source.
const long = 'a'.repeat(101);

createTester().run('declare-description', rule, {
	valid: [
		// Emoji are measured by code point (Discord's unit), not UTF-16: 51 code points <= 100.
		`import { Command, Declare } from 'seyfert';
@Declare({ name: 'c', description: '${'📊'.repeat(51)}' })
class C extends Command {}`,
		// Chat command with an acceptable description.
		`import { Command, Declare } from 'seyfert';
@Declare({ name: 'c', description: 'a good description' })
class C extends Command {}`,
		// SubCommand with an acceptable description.
		`import { SubCommand, Declare } from 'seyfert';
@Declare({ name: 's', description: 'sub' })
class S extends SubCommand {}`,
		// Option builder with an acceptable description (also exercises the chat path).
		`import { Command, Declare, Options, createStringOption } from 'seyfert';
@Declare({ name: 'c', description: 'c' })
@Options({ query: createStringOption({ description: 'q' }) })
class C extends Command {}`,
		// Exactly 100 characters is allowed.
		`import { Command, Declare } from 'seyfert';
@Declare({ name: 'c', description: '${'a'.repeat(100)}' })
class C extends Command {}`,
		// Skip: context-menu @Declare (no description) is not this rule's concern.
		`import { ContextMenuCommand, Declare, ApplicationCommandType } from 'seyfert';
@Declare({ type: ApplicationCommandType.Message, name: 'm' })
class M extends ContextMenuCommand {}`,
		// Skip: non-literal description is not statically checkable.
		`import { Command, Declare } from 'seyfert';
const d = String(Date.now());
@Declare({ name: 'c', description: d })
class C extends Command {}`,
		// Soundness: a local, non-seyfert \`Declare\` look-alike is never flagged.
		`import { Command } from 'seyfert';
function Declare(_o: { name: string; description: string }) {
	return (_t: unknown) => {};
}
@Declare({ name: 'c', description: '' })
class C extends Command {}`,
		// Soundness: a local, non-seyfert \`createStringOption\` look-alike is never flagged.
		`function createStringOption(data: { description: string }) {
	return data;
}
createStringOption({ description: '' });`,
	],
	invalid: [
		{
			// Empty chat description.
			code: `import { Command, Declare } from 'seyfert';
@Declare({ name: 'c', description: '' })
class C extends Command {}`,
			errors: [{ messageId: 'emptyDescription', data: { what: 'Command' } }],
		},
		{
			// 101-character chat description.
			code: `import { Command, Declare } from 'seyfert';
@Declare({ name: 'c', description: '${long}' })
class C extends Command {}`,
			errors: [{ messageId: 'descriptionTooLong', data: { what: 'Command', length: 101 } }],
		},
		{
			// Empty option description.
			code: `import { Command, Declare, Options, createStringOption } from 'seyfert';
@Declare({ name: 'c', description: 'c' })
@Options({ query: createStringOption({ description: '' }) })
class C extends Command {}`,
			errors: [{ messageId: 'emptyDescription', data: { what: 'Option' } }],
		},
		{
			// 101-character option description.
			code: `import { Command, Declare, Options, createStringOption } from 'seyfert';
@Declare({ name: 'c', description: 'c' })
@Options({ query: createStringOption({ description: '${long}' }) })
class C extends Command {}`,
			errors: [{ messageId: 'descriptionTooLong', data: { what: 'Option', length: 101 } }],
		},
	],
});
