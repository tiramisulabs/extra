import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
	extendsSeyfertClass,
	getServices,
	instanceTypeOfExpression,
	isSeyfertSymbol,
	objectProperty,
	resolveObjectLiteral,
} from '../utils';

const CONTEXT_MENU: ReadonlySet<string> = new Set(['ContextMenuCommand']);

/**
 * A seyfert `ContextMenuCommand` must declare its kind. Its `@Declare` has to
 * carry `type: ApplicationCommandType.User | .Message` and must NOT include a
 * `description` (descriptions are chat-command only). TypeScript does not catch
 * this because the `@Declare` parameter is a union that isn't tied back to the
 * class it decorates.
 *
 * Type-aware and sound: only fires when the base class is seyfert's own
 * `ContextMenuCommand` and the decorator is seyfert's own `Declare`. The
 * argument is read only when it statically resolves to an object literal; a
 * `type` supplied through a spread is treated as unknown (no false positive).
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'context-menu-declare',
		meta: {
			type: 'problem',
			docs: {
				description: "A `ContextMenuCommand`'s `@Declare` must set `type` and must not set `description`.",
			},
			messages: {
				missingType: "A context-menu command's `@Declare` must set `type: ApplicationCommandType.User` or `.Message`.",
				hasDescription: "A context-menu command's `@Declare` must not include a `description`.",
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			const checkClass = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression) => {
				if (!node.superClass) return;
				const decorators = node.decorators;
				if (!decorators || decorators.length === 0) return;

				const services = getServices(context);
				if (!services) return;
				const checker = services.program.getTypeChecker();

				const superType = instanceTypeOfExpression(checker, services, node.superClass);
				if (!superType || !extendsSeyfertClass(checker, superType, CONTEXT_MENU)) return;

				// The seyfert `@Declare(...)` decorator on this class, if any.
				let declareDecorator: TSESTree.Decorator | undefined;
				for (const decorator of decorators) {
					const expression = decorator.expression;
					const callee = expression.type === 'CallExpression' ? expression.callee : expression;
					if (isSeyfertSymbol(checker, services.getSymbolAtLocation(callee), 'Declare')) {
						declareDecorator = decorator;
						break;
					}
				}
				if (!declareDecorator) return;

				const expression = declareDecorator.expression;
				if (expression.type !== 'CallExpression') return;
				const argument = expression.arguments[0];
				if (!argument || argument.type === 'SpreadElement') return;

				const argumentTsNode = services.esTreeNodeToTSNodeMap.get(argument);
				if (!argumentTsNode) return;
				const options = resolveObjectLiteral(checker, argumentTsNode as ts.Expression, new Set());
				if (!options) return;

				// A spread could carry `type`, so we cannot prove it is absent.
				const hasSpread = options.properties.some(property => ts.isSpreadAssignment(property));
				if (!hasSpread && objectProperty(options, 'type') === undefined) {
					context.report({ node: declareDecorator, messageId: 'missingType' });
				}

				const description = objectProperty(options, 'description');
				if (description) {
					const propertyNode = ts.isPropertyAssignment(description.parent) ? description.parent : description;
					const reportNode =
						(services.tsNodeToESTreeNodeMap.get(propertyNode) as TSESTree.Node | undefined) ?? declareDecorator;
					context.report({ node: reportNode, messageId: 'hasDescription' });
				}
			};

			return { ClassDeclaration: checkClass, ClassExpression: checkClass };
		},
	});
}
