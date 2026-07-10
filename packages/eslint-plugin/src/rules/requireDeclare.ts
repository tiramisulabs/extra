import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { extendsSeyfertCommand, getServices, hasSeyfertDecorator, instanceTypeOfExpression } from '../utils';

/**
 * Require the `@Declare` decorator on classes that extend a seyfert command
 * base. The check is type-aware: it confirms the base class actually comes from
 * the `seyfert` package (not any same-named local class) and that the decorator
 * is seyfert's own `Declare`.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'require-declare',
		meta: {
			type: 'problem',
			docs: {
				description: 'Seyfert command classes must be decorated with `@Declare`.',
			},
			messages: {
				missingDeclare: 'This class extends a Seyfert command but is missing the `@Declare` decorator.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			const checkClass = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression) => {
				// Abstract intermediate bases are not registered commands themselves.
				if (node.abstract || !node.superClass) return;

				const services = getServices(context);
				if (!services) return;
				const checker = services.program.getTypeChecker();

				const superType = instanceTypeOfExpression(checker, services, node.superClass);
				if (!superType || !extendsSeyfertCommand(checker, superType)) return;

				if (hasSeyfertDecorator(checker, services, node.decorators, 'Declare')) return;

				context.report({ node: node.id ?? node, messageId: 'missingDeclare' });
			};

			return {
				ClassDeclaration: checkClass,
				ClassExpression: checkClass,
			};
		},
	});
}
