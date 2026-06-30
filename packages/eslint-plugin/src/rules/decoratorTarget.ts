import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { extendsSeyfertClass, getServices, instanceTypeOfExpression, seyfertExportName } from '../utils';

const SUBCOMMAND: ReadonlySet<string> = new Set(['SubCommand']);
const COMMAND: ReadonlySet<string> = new Set(['Command']);

// Seyfert structural decorator -> the command base it must be applied to.
const TARGETS = new Map<string, { base: string; names: ReadonlySet<string> }>([
	['Group', { base: 'SubCommand', names: SUBCOMMAND }],
	['Groups', { base: 'Command', names: COMMAND }],
	['GroupsT', { base: 'Command', names: COMMAND }],
	['AutoLoad', { base: 'Command', names: COMMAND }],
]);

/**
 * Seyfert's structural decorators must target the right command class:
 * `@Group` only on a `SubCommand`, and `@Groups`/`@GroupsT`/`@AutoLoad` only on
 * a `Command`. Type-aware: only seyfert's own decorators are checked, and the
 * base class is resolved through the type checker (transitive bases included).
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'decorator-target',
		meta: {
			type: 'problem',
			docs: {
				description: '`@Group` belongs on a SubCommand; `@Groups`/`@GroupsT`/`@AutoLoad` belong on a Command.',
			},
			messages: {
				wrongTarget: "`@{{decorator}}` can only be used on a class that extends seyfert's `{{base}}`.",
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
					if (name === undefined) continue;

					const target = TARGETS.get(name);
					if (!target) continue;

					if (!superType || !extendsSeyfertClass(checker, superType, target.names)) {
						context.report({
							node: decorator,
							messageId: 'wrongTarget',
							data: { decorator: name, base: target.base },
						});
					}
				}
			};

			return { ClassDeclaration: checkClass, ClassExpression: checkClass };
		},
	});
}
