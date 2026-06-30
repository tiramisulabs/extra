import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
	booleanLiteralValue,
	constInitializer,
	getServices,
	isSeyfertSymbol,
	objectProperty,
	propertyName,
	resolveObjectLiteral,
	seyfertOptionBuilderName,
	unwrap,
} from '../utils';

/**
 * Discord rejects a chat-input command whose **required** option is declared
 * *after* an optional one. Seyfert v5 does not enforce option order at the type
 * level, so this rule flags it inside a seyfert `@Options({ ... })` decorator.
 *
 * Type-aware and intentionally conservative: it only inspects seyfert's own
 * `Options` decorator (verified by package origin), only treats values produced
 * by a seyfert `createXOption` builder as options, and only acts on a literal
 * `required: true | false`. Anything dynamic or unresolvable is ignored so the
 * rule never guesses — the array form `@Options([Sub])` is skipped entirely.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'required-options-order',
		meta: {
			type: 'problem',
			docs: {
				description: 'Required command options must be declared before optional ones.',
			},
			messages: {
				requiredAfterOptional:
					'Required option `{{name}}` must be declared before optional options (Discord rejects required options placed after optional ones).',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				Decorator(node) {
					const expression = node.expression;
					if (expression.type !== 'CallExpression') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					// Only seyfert's own `Options` decorator (verified by package origin).
					if (!isSeyfertSymbol(checker, services.getSymbolAtLocation(expression.callee), 'Options')) return;

					const argument = expression.arguments[0];
					if (!argument || argument.type === 'SpreadElement') return;

					const argumentTsNode = services.esTreeNodeToTSNodeMap.get(argument);
					if (!argumentTsNode) return;

					// Resolves through `const`/imports; undefined for the array form or anything dynamic.
					const optionsObject = resolveObjectLiteral(checker, argumentTsNode as ts.Expression, new Set());
					if (!optionsObject) return;

					let sawOptional = false;

					for (const property of optionsObject.properties) {
						if (!ts.isPropertyAssignment(property)) continue;

						// The value must resolve to a seyfert `createXOption` builder call; follow a
						// single `const` hop. Anything else is not a tracked option -> skip entirely.
						let value = unwrap(property.initializer);
						if (ts.isIdentifier(value)) {
							const initializer = constInitializer(checker, value);
							if (initializer) value = unwrap(initializer);
						}
						if (seyfertOptionBuilderName(checker, value) === undefined) continue;

						const call = unwrap(value);
						if (!ts.isCallExpression(call)) continue;

						const config = call.arguments[0];
						if (!config) continue;
						const configObject = unwrap(config);
						if (!ts.isObjectLiteralExpression(configObject)) continue;

						const requiredExpression = objectProperty(configObject, 'required');
						const configHasSpread = configObject.properties.some(member => ts.isSpreadAssignment(member));
						const required = requiredExpression ? booleanLiteralValue(requiredExpression) : undefined;

						if (required === true) {
							if (sawOptional) {
								const reportNode =
									(services.tsNodeToESTreeNodeMap.get(property) as TSESTree.Node | undefined) ?? argument;
								context.report({
									node: reportNode,
									messageId: 'requiredAfterOptional',
									data: { name: propertyName(property.name) },
								});
							}
						} else if (required === false || (requiredExpression === undefined && !configHasSpread)) {
							// Optional: explicit `required: false` or no `required` key at all.
							sawOptional = true;
						}
						// `required` present but non-literal: unknown -> neither boundary nor report.
					}
				},
			};
		},
	});
}
