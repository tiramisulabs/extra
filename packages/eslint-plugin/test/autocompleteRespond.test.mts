import { ESLintUtils } from '@typescript-eslint/utils';
import autocompleteRespondFactory from '../src/rules/autocompleteRespond';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/autocomplete-respond');
const rule = autocompleteRespondFactory(createRule);

createTester().run('autocomplete-respond', rule, {
	valid: [
		// The correct method on an autocomplete interaction.
		`import type { AutocompleteInteraction } from 'seyfert';
const f = (i: AutocompleteInteraction) => {
	i.respond([]);
};`,
		// `.reply` on a NON-autocomplete interaction is fine (its `.reply` is real).
		`import { InteractionResponseType, type ChatInputCommandInteraction } from 'seyfert';
const f = (i: ChatInputCommandInteraction) => {
	i.reply({ type: InteractionResponseType.LaunchActivity });
};`,
		// Soundness: a plain object that merely has a `reply` method is not seyfert.
		`const o = { reply() {} };
o.reply();`,
		// Soundness: a local, same-named look-alike must NOT be flagged.
		`class AutocompleteInteraction {
	reply(..._args: unknown[]) {}
}
const f = (i: AutocompleteInteraction) => {
	i.reply([]);
};`,
		// Scope: the rule deliberately only matches dot-access `.reply`, so a
		// computed `['reply']` access is out of scope and not reported.
		`import type { AutocompleteInteraction } from 'seyfert';
const f = (i: AutocompleteInteraction) => {
	i['reply']([]);
};`,
	],
	invalid: [
		{
			// PRIMARY: explicit annotation guarantees the autocomplete typing.
			code: `import type { AutocompleteInteraction } from 'seyfert';
const f = (i: AutocompleteInteraction) => {
	i.reply([]);
};`,
			errors: [{ messageId: 'useRespond' }],
		},
		{
			// Real callback form: `i` is contextually typed AutocompleteInteraction.
			code: `import { createStringOption } from 'seyfert';
createStringOption({
	description: 'x',
	autocomplete(i) {
		i.reply([]);
	},
});`,
			errors: [{ messageId: 'useRespond' }],
		},
		{
			// A subclass of AutocompleteInteraction is still an autocomplete receiver.
			code: `import { AutocompleteInteraction } from 'seyfert';
class MyAuto extends AutocompleteInteraction {}
const f = (i: MyAuto) => {
	i.reply([]);
};`,
			errors: [{ messageId: 'useRespond' }],
		},
	],
});
