import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { getServices } from '../utils';

/** Where seyfert's `SeyfertLocale` proxy (the `.get()` accessor) is declared. */
const SEYFERT_DECL = /[\\/]seyfert[\\/]lib[\\/]langs[\\/]/;

/**
 * Seyfert's `ctx.t.some.path` resolves to a `SeyfertLocale` proxy whose leaves
 * expose a `.get(locale?)` method; using the proxy directly as a string yields
 * the proxy object, not the localized text. This rule flags a proxy used
 * WITHOUT `.get()`, but only inside two clearly-string contexts to stay sound:
 * template-literal `${...}` expressions and string `+` concatenation.
 *
 * Detection is heuristic but type-anchored: an expression is a misuse only when
 * its type exposes a `get` member whose declaration lives in the seyfert
 * package. A resolved `.get()` call returns a plain `string` (no `get` member)
 * so it never matches, and a non-seyfert object that happens to have a `get`
 * method is never flagged (its declaration is not in `seyfert/lib`).
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'i18n-resolve-with-get',
		meta: {
			type: 'problem',
			docs: {
				description: 'Resolve a seyfert `ctx.t` locale proxy with `.get()` before using it as a string.',
			},
			messages: {
				callGet: '`ctx.t` returns a locale proxy — resolve it with `.get()` before using it as a string.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			const services = getServices(context);
			if (!services) return {};

			// Whether `expression`'s type is a seyfert locale proxy (its `get` member
			// originates in the seyfert package) — i.e. a proxy used without `.get()`.
			const isLocaleProxyMisuse = (expression: TSESTree.Expression): boolean => {
				const type = services.getTypeAtLocation(expression);
				const getSymbol = type.getProperty('get');
				if (!getSymbol) return false;
				return (getSymbol.getDeclarations() ?? []).some(declaration =>
					SEYFERT_DECL.test(declaration.getSourceFile().fileName),
				);
			};

			return {
				TemplateLiteral(node) {
					for (const expression of node.expressions) {
						if (isLocaleProxyMisuse(expression)) {
							context.report({ node: expression, messageId: 'callGet' });
						}
					}
				},
				BinaryExpression(node) {
					if (node.operator !== '+') return;
					if (isLocaleProxyMisuse(node.left)) {
						context.report({ node: node.left, messageId: 'callGet' });
					}
					if (isLocaleProxyMisuse(node.right)) {
						context.report({ node: node.right, messageId: 'callGet' });
					}
				},
			};
		},
	});
}
