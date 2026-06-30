import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
	extendsSeyfertClass,
	getServices,
	instanceTypeOfExpression,
	isSeyfertSymbol,
	objectProperty,
	resolveObjectLiteral,
	seyfertOptionBuilderName,
	stringLiteralValue,
} from '../utils';

type Services = NonNullable<ReturnType<typeof getServices>>;

/** Discord rejects empty chat descriptions and any description longer than this. */
const MAX_DESCRIPTION = 100;

/** Chat-command bases whose `@Declare` carries a real (Discord-visible) description. */
const CHAT_BASES: ReadonlySet<string> = new Set(['Command', 'SubCommand']);

/**
 * Seyfert v5 makes `description` required on `@Declare` (and on option builders)
 * by type, but it cannot stop a description that is empty or longer than the 100
 * characters Discord allows. This rule fills that gap with two independent,
 * type-aware checks — both fire only on seyfert's own symbols and only when the
 * description is a static string literal:
 *
 *  A. The `@Declare({ description })` of a class extending a seyfert chat command
 *     (`Command`/`SubCommand`). Context-menu / entry-point declares (which omit a
 *     description) are left to other rules.
 *  B. The first argument of a seyfert `createXOption` builder call.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'declare-description',
		meta: {
			type: 'problem',
			docs: {
				description: 'Seyfert command and option descriptions must be non-empty and at most 100 characters.',
			},
			messages: {
				emptyDescription: '{{what}} description must not be empty.',
				descriptionTooLong: '{{what}} description must be at most 100 characters (got {{length}}).',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			// Validate the `description` property of a resolved options object literal.
			const checkDescription = (
				services: Services,
				object: ts.ObjectLiteralExpression,
				what: 'Command' | 'Option',
				fallback: TSESTree.Node,
			) => {
				const descriptionNode = objectProperty(object, 'description');
				if (!descriptionNode) return; // absent
				const value = stringLiteralValue(descriptionNode);
				if (value === undefined) return; // dynamic / non-literal -> skip
				// Discord counts Unicode code points, not UTF-16 units, so a description with emoji
				// (surrogate pairs) must be measured by code point.
				const length = [...value].length;
				if (value !== '' && length <= MAX_DESCRIPTION) return; // ok

				const node = (services.tsNodeToESTreeNodeMap.get(descriptionNode) as TSESTree.Node | undefined) ?? fallback;
				if (value === '') {
					context.report({ node, messageId: 'emptyDescription', data: { what } });
				} else {
					context.report({ node, messageId: 'descriptionTooLong', data: { what, length } });
				}
			};

			return {
				// CHECK A — chat command `@Declare({ description })`.
				Decorator(node) {
					const expression = node.expression;
					if (expression.type !== 'CallExpression') return;

					const parent = node.parent;
					if (parent.type !== 'ClassDeclaration' && parent.type !== 'ClassExpression') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					// Only seyfert's own `Declare` (verified by package origin).
					if (!isSeyfertSymbol(checker, services.getSymbolAtLocation(expression.callee), 'Declare')) return;

					// Must extend a chat command base; otherwise this description isn't ours to check.
					const superType = parent.superClass
						? instanceTypeOfExpression(checker, services, parent.superClass)
						: undefined;
					if (!superType || !extendsSeyfertClass(checker, superType, CHAT_BASES)) return;

					const argument = expression.arguments[0];
					if (!argument || argument.type === 'SpreadElement') return;
					const argumentTsNode = services.esTreeNodeToTSNodeMap.get(argument);
					if (!argumentTsNode) return;
					const object = resolveObjectLiteral(checker, argumentTsNode as ts.Expression, new Set());
					if (!object) return;

					checkDescription(services, object, 'Command', argument);
				},

				// CHECK B — seyfert `createXOption({ description })` builder calls.
				CallExpression(node) {
					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					const tsNode = services.esTreeNodeToTSNodeMap.get(node);
					if (!tsNode || !ts.isCallExpression(tsNode)) return;
					if (seyfertOptionBuilderName(checker, tsNode) === undefined) return;

					const argument = tsNode.arguments[0];
					if (!argument) return;
					const object = resolveObjectLiteral(checker, argument, new Set());
					if (!object) return;

					checkDescription(services, object, 'Option', node);
				},
			};
		},
	});
}
