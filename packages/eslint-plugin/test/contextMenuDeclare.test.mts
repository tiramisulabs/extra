import { ESLintUtils } from '@typescript-eslint/utils';
import contextMenuDeclareFactory from '../src/rules/contextMenuDeclare';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/context-menu-declare');
const rule = contextMenuDeclareFactory(createRule);

const code = (body: string) =>
	`import { ContextMenuCommand, Command, Declare, ApplicationCommandType } from 'seyfert';\n${body}`;

createTester().run('context-menu-declare', rule, {
	valid: [
		// \`type\` via ES2015 shorthand is present — must not be flagged.
		`import { ContextMenuCommand, Declare, ApplicationCommandType } from 'seyfert';
const type = ApplicationCommandType.User;
@Declare({ name: 'avatar', type })
class S extends ContextMenuCommand {}`,
		// \`type\` via a computed string key is present — must not be flagged.
		`import { ContextMenuCommand, Declare, ApplicationCommandType } from 'seyfert';
@Declare({ name: 'avatar', ['type']: ApplicationCommandType.User })
class S extends ContextMenuCommand {}`,
		// Message menu with a type and no description.
		code(`@Declare({ type: ApplicationCommandType.Message, name: 'm' }) class M extends ContextMenuCommand {}`),
		// User menu with a type and no description.
		code(`@Declare({ type: ApplicationCommandType.User, name: 'm' }) class M extends ContextMenuCommand {}`),
		// A chat command is unrelated and must be ignored, description and all.
		code(`@Declare({ name: 'c', description: 'd' }) class C extends Command {}`),
		// Type supplied through a spread is unknown -> no `missingType` false positive.
		code(
			`const base = { type: ApplicationCommandType.Message } as const;\n@Declare({ ...base, name: 'm' }) class M extends ContextMenuCommand {}`,
		),
		// Soundness: a local, non-seyfert `ContextMenuCommand`/`Declare` look-alike is ignored.
		`function Declare(_o: unknown) { return (_t: unknown) => {}; }
class ContextMenuCommand {}
@Declare({ name: 'm' }) class M extends ContextMenuCommand {}`,
		// Soundness: a real seyfert menu decorated with a NON-seyfert `Declare` is ignored.
		`import { ContextMenuCommand } from 'seyfert';
function Declare(_o: unknown) { return (_t: unknown) => {}; }
@Declare({ name: 'm' }) class M extends ContextMenuCommand {}`,
	],
	invalid: [
		{
			// Has a type but also a forbidden description.
			code: code(
				`@Declare({ type: ApplicationCommandType.Message, name: 'm', description: 'd' }) class M extends ContextMenuCommand {}`,
			),
			errors: [{ messageId: 'hasDescription' }],
		},
		{
			// Chat-shaped @Declare on a menu: missing the type AND carrying a description.
			code: code(`@Declare({ name: 'm', description: 'd' }) class M extends ContextMenuCommand {}`),
			errors: [{ messageId: 'missingType' }, { messageId: 'hasDescription' }],
		},
		{
			// Resolved through a same-file const: missing type, has description.
			// Errors are sorted by source position; the `description` (line 2) is
			// reported before the decorator's `missingType` (line 3).
			code: code(`const opts = { name: 'm', description: 'd' };\n@Declare(opts) class M extends ContextMenuCommand {}`),
			errors: [{ messageId: 'hasDescription' }, { messageId: 'missingType' }],
		},
	],
});
