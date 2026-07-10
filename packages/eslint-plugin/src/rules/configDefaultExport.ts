import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { getServices, isSeyfertSymbol } from '../utils';

/**
 * Seyfert loads a `seyfert.config.*` file through its **default export**, so the
 * result of seyfert's `config.bot(...)` / `config.http(...)` must be exactly the
 * file's `export default`.
 *
 * Detection is type-aware (NOT filename-based): the call's object must resolve to
 * seyfert's own `config` export, verified by package origin — a same-named local
 * `config` object is never flagged.
 *
 * Known limitation: only the idiomatic, direct form `export default config.bot(...)`
 * is accepted. An indirection like `const c = config.bot(...); export default c`
 * is (conservatively) flagged even though it is technically valid at runtime,
 * because the rule reports on the call site rather than tracing the export graph.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'config-default-export',
		meta: {
			type: 'problem',
			docs: {
				description: "The result of seyfert's `config.bot()`/`config.http()` must be the file's `export default`.",
			},
			messages: {
				mustDefaultExport: "The result of `config.{{method}}()` must be the file's `export default`.",
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				CallExpression(node) {
					const callee = node.callee;
					if (callee.type !== 'MemberExpression' || callee.computed) return;
					if (callee.property.type !== 'Identifier') return;

					const method = callee.property.name;
					if (method !== 'bot' && method !== 'http') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					// Only seyfert's own `config` object (verified by package origin).
					if (!isSeyfertSymbol(checker, services.getSymbolAtLocation(callee.object), 'config')) return;

					// Unwrap any `as` / `satisfies` / `<T>` / `!` wrapping the default export.
					let parent: TSESTree.Node = node.parent;
					while (
						parent.type === 'TSAsExpression' ||
						parent.type === 'TSSatisfiesExpression' ||
						parent.type === 'TSNonNullExpression' ||
						parent.type === 'TSTypeAssertion'
					) {
						parent = parent.parent;
					}
					if (parent.type !== 'ExportDefaultDeclaration') {
						context.report({ node, messageId: 'mustDefaultExport', data: { method } });
					}
				},
			};
		},
	});
}
