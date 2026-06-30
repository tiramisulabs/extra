import { ESLintUtils } from '@typescript-eslint/utils';
import type { ESLint } from 'eslint';
import autocompleteRespond from './autocompleteRespond';
import configDefaultExport from './configDefaultExport';
import contextMenuDeclare from './contextMenuDeclare';
import declareDescription from './declareDescription';
import decoratorOnCommand from './decoratorOnCommand';
import decoratorTarget from './decoratorTarget';
import groupExists from './groupExists';
import i18nResolveWithGet from './i18nResolveWithGet';
import noDeepImports from './noDeepImports';
import noHangingMiddleware from './noHangingMiddleware';
import optionsUseBuilders from './optionsUseBuilders';
import preferTypedGroup from './preferTypedGroup';
import requireDeclare from './requireDeclare';
import requiredOptionsOrder from './requiredOptionsOrder';

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
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'decorator-target': decoratorTarget(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'required-options-order': requiredOptionsOrder(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'declare-description': declareDescription(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'context-menu-declare': contextMenuDeclare(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'autocomplete-respond': autocompleteRespond(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'decorator-on-command': decoratorOnCommand(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'config-default-export': configDefaultExport(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'i18n-resolve-with-get': i18nResolveWithGet(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'group-exists': groupExists(createRule),
		// @ts-expect-error typescript-eslint RuleModule vs core ESLint RuleModule variance.
		'prefer-typed-group': preferTypedGroup(createRule),
	},
};

export default plugin;
