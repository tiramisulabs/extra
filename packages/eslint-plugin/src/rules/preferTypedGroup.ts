import type { ESLintUtils } from '@typescript-eslint/utils';
import { getServices, isSeyfertSymbol } from '../utils';

/**
 * Seyfert's `@Group(name)` takes a bare string that is never checked against the
 * command's declared groups, so a typo silently routes a subcommand into a group
 * that does not exist. The two-argument overload `@Group(groups, name)` — where
 * `groups` is a `defineGroups(...)` / `@Groups` object — constrains `name` to
 * `keyof typeof groups`, turning that typo into a compile error.
 *
 * This rule nudges the single-argument form towards the typed one. It is a
 * suggestion, not a correctness error: the single-argument form works at runtime
 * (which is exactly why a typo can't be caught any other way — a subcommand and
 * its parent command usually live in different files, often wired by `@AutoLoad`
 * with no code reference between them, so the valid group set is not statically
 * reachable from the subcommand). Type-aware: only seyfert's own `Group`
 * decorator is considered, so a same-named local/third-party `Group` is ignored.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'prefer-typed-group',
		meta: {
			type: 'suggestion',
			docs: {
				description: 'Prefer the type-safe two-argument `@Group(groups, name)` overload over a bare `@Group(name)`.',
			},
			messages: {
				preferTypedGroup:
					'Prefer the two-argument `@Group(groups, name)` overload so the group name is validated against the declared groups.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				Decorator(node) {
					const expression = node.expression;
					if (expression.type !== 'CallExpression') return;

					// The typed overload `@Group(groups, name)` has two arguments — leave it alone.
					// A spread is unresolvable, so we can't prove it's the single-argument form.
					if (expression.arguments.length !== 1 || expression.arguments[0].type === 'SpreadElement') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					// Only seyfert's own `Group` decorator (verified by package origin).
					if (!isSeyfertSymbol(checker, services.getSymbolAtLocation(expression.callee), 'Group')) return;

					context.report({ node, messageId: 'preferTypedGroup' });
				},
			};
		},
	});
}
