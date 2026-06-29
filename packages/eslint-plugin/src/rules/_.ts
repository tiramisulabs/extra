import { ESLintUtils } from '@typescript-eslint/utils';
import type { ESLint } from 'eslint';
import noDeepImports from './noDeepImports';
import noHangingMiddleware from './noHangingMiddleware';
import optionsUseBuilders from './optionsUseBuilders';
import requireDeclare from './requireDeclare';

// ponytail: single shared RuleCreator injected into every rule (eslintcf pattern).
const createRule = ESLintUtils.RuleCreator(
	name => `https://github.com/tiramisulabs/extra/tree/main/packages/eslint-plugin/docs/${name}.md`,
);

const plugin: ESLint.Plugin = {
	meta: { name: '@slipher/eslint-plugin', version: '0.1.0' },
	rules: {
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'require-declare': requireDeclare(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'no-deep-imports': noDeepImports(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'options-use-builders': optionsUseBuilders(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'no-hanging-middleware': noHangingMiddleware(createRule),
	},
};

export default plugin;
