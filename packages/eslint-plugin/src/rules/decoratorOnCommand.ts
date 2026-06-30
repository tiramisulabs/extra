import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { extendsSeyfertCommand, getServices, instanceTypeOfExpression, seyfertExportName } from '../utils';

// Seyfert command decorators that only make sense on a class extending a command
// base. `Group`/`Groups`/`GroupsT`/`AutoLoad` are owned by `decorator-target`, so
// they are deliberately excluded here to avoid double reporting.
const COMMAND_DECORATORS: ReadonlySet<string> = new Set(['Declare', 'Options', 'Middlewares', 'Locales', 'LocalesT']);

/**
 * Seyfert command decorators (`@Declare`, `@Options`, `@Middlewares`, `@Locales`,
 * `@LocalesT`) may only decorate a class that extends a seyfert command base
 * (`Command`, `SubCommand`, …). Type-aware: only seyfert's own decorators are
 * checked, and the base class is resolved through the type checker (transitive
 * bases included), so a same-named local/3rd-party decorator never triggers.
 *
 * Known limitation: a command base reached only through a TypeScript mixin
 * (`extends Mix(Command)`) or a conditional base is not detected — its instance
 * type is an intersection/union whose constituents aren't walked — so the
 * decorator may be flagged there. Idiomatic plain inheritance is handled.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'decorator-on-command',
		meta: {
			type: 'problem',
			docs: {
				description: '`@Declare`/`@Options`/`@Middlewares`/`@Locales`/`@LocalesT` belong on a seyfert command class.',
			},
			messages: {
				onCommandOnly:
					'`@{{decorator}}` can only be applied to a class that extends a seyfert command base (e.g. `Command`, `SubCommand`).',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			const checkClass = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression) => {
				const decorators = node.decorators;
				if (!decorators || decorators.length === 0) return;

				const services = getServices(context);
				if (!services) return;
				const checker = services.program.getTypeChecker();

				const superType = node.superClass ? instanceTypeOfExpression(checker, services, node.superClass) : undefined;

				for (const decorator of decorators) {
					const expression = decorator.expression;
					const callee = expression.type === 'CallExpression' ? expression.callee : expression;
					const name = seyfertExportName(checker, services.getSymbolAtLocation(callee));
					if (name === undefined || !COMMAND_DECORATORS.has(name)) continue;

					if (!superType || !extendsSeyfertCommand(checker, superType)) {
						context.report({
							node: decorator,
							messageId: 'onCommandOnly',
							data: { decorator: name },
						});
					}
				}
			};

			return { ClassDeclaration: checkClass, ClassExpression: checkClass };
		},
	});
}
