import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import { getServices } from '../utils';

/** A declaration that lives inside the installed `seyfert` package. */
const SEYFERT_DECL = /[\\/]seyfert[\\/]lib[\\/]/;

/** Whether `type` (or, for a union/intersection, any constituent) exposes `name` as a method declared in seyfert. */
function isSeyfertMethod(type: ts.Type, name: string): boolean {
	if (type.isUnionOrIntersection()) {
		return type.types.some(constituent => isSeyfertMethod(constituent, name));
	}
	const symbol = type.getProperty(name);
	return (symbol?.declarations ?? []).some(
		declaration =>
			(ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) &&
			SEYFERT_DECL.test(declaration.getSourceFile().fileName),
	);
}

/**
 * Destructuring a method off a seyfert object detaches it from its `this`, so the
 * standalone reference throws when called (`TypeError: Cannot read properties of
 * undefined`). seyfert's context / structure / builder methods are `this`-bound
 * prototype methods — e.g. `ctx.editOrReply` reads `this.interaction`, so
 * `const { editOrReply } = ctx; editOrReply(...)` crashes.
 *
 * This rule flags a destructured **method** of any seyfert class. Getters and
 * plain properties are left alone: reading their value by destructuring is safe.
 * The general form of this bug is covered by `@typescript-eslint/unbound-method`;
 * this is the zero-config, seyfert-scoped variant (no whole-codebase noise, and
 * it never needs the method body — seyfert ships declarations only).
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'no-method-destructure',
		meta: {
			type: 'problem',
			docs: {
				description: 'Do not destructure a method off a seyfert object — it loses its `this` binding.',
			},
			messages: {
				methodDestructure:
					'`{{name}}` is a method of a seyfert class; destructuring it loses its `this` binding and it will throw when called. Keep it on the object and call `object.{{name}}(...)`.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				ObjectPattern(node: TSESTree.ObjectPattern) {
					const services = getServices(context);
					if (!services) return;

					// The type of the value being destructured.
					const source = node.parent.type === 'VariableDeclarator' && node.parent.init ? node.parent.init : node;
					const type = services.getTypeAtLocation(source);
					if (!type) return;

					for (const property of node.properties) {
						if (property.type !== 'Property' || property.computed) continue;
						const key = property.key;
						const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined;
						if (name === undefined) continue;

						if (isSeyfertMethod(type, name)) {
							context.report({ node: property.key, messageId: 'methodDestructure', data: { name } });
						}
					}
				},
			};
		},
	});
}
