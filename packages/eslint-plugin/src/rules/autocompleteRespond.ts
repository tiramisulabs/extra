import type { ESLintUtils } from '@typescript-eslint/utils';
import { extendsSeyfertClass, getServices } from '../utils';

const AUTOCOMPLETE: ReadonlySet<string> = new Set(['AutocompleteInteraction']);

/**
 * An autocomplete interaction must be answered with `.respond(...)`. Seyfert's
 * `AutocompleteInteraction` also exposes a `.reply(...)` method, but it is
 * `@internal` and THROWS at runtime — it only exists so the type lines up with
 * the other interactions. This rule flags `<x>.reply(...)` whenever `x`'s type
 * is (or extends) seyfert's own `AutocompleteInteraction`.
 *
 * Type-aware and sound: the receiver type is resolved through the checker and
 * its origin verified against the `seyfert` package, so a same-named local or
 * third-party type — or a plain object with a `reply` method — is never flagged.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'autocomplete-respond',
		meta: {
			type: 'problem',
			docs: {
				description: 'Answer a seyfert autocomplete interaction with `.respond()`, not the internal `.reply()`.',
			},
			messages: {
				useRespond: 'Use `.respond()` on an autocomplete interaction; `.reply()` is internal and throws.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				CallExpression(node) {
					const callee = node.callee;
					if (callee.type !== 'MemberExpression' || callee.computed) return;
					if (callee.property.type !== 'Identifier' || callee.property.name !== 'reply') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					const type = services.getTypeAtLocation(callee.object);
					if (extendsSeyfertClass(checker, type, AUTOCOMPLETE)) {
						context.report({ node: callee.property, messageId: 'useRespond' });
					}
				},
			};
		},
	});
}
