import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
	extendsSeyfertCommand,
	getServices,
	hasSeyfertDecorator,
	instanceTypeOfExpression,
	isSeyfertSymbol,
	seyfertExportName,
	unalias,
} from '../utils';

/** A class implemented elsewhere: `declare`d, or written in a declaration file. */
function isAmbient(node: ts.ClassLikeDeclaration): boolean {
	return node.getSourceFile().isDeclarationFile || (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0;
}

/**
 * Whether a class that `node` extends may already carry seyfert's `@Declare`: the
 * decorator returns a subclass that sets the declaration as class fields, so it is
 * inherited. Also `true` when a base can't be inspected (ambient or `.d.ts`, a
 * factory call, a mixin), so a declaration that may exist is never reported missing.
 */
function mayInheritDeclare(checker: ts.TypeChecker, node: ts.ClassLikeDeclaration): boolean {
	const seen = new Set<ts.Node>();
	let current = node;
	for (;;) {
		const base = current.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
		const symbol = base && checker.getSymbolAtLocation(base.expression);
		// Reached seyfert's own command base: no user class left to inherit from.
		if (seyfertExportName(checker, symbol) !== undefined) return false;
		const declaration = symbol && unalias(checker, symbol).valueDeclaration;
		if (!declaration || !ts.isClassLike(declaration) || isAmbient(declaration)) return true;
		if (seen.has(declaration)) return true;
		seen.add(declaration);
		for (const decorator of ts.getDecorators(declaration) ?? []) {
			const expression = decorator.expression;
			const callee = ts.isCallExpression(expression) ? expression.expression : expression;
			if (isSeyfertSymbol(checker, checker.getSymbolAtLocation(callee), 'Declare')) return true;
		}
		current = declaration;
	}
}

/**
 * Require the `@Declare` decorator on classes that extend a seyfert command
 * base. The check is type-aware: it confirms the base class actually comes from
 * the `seyfert` package (not any same-named local class) and that the decorator
 * is seyfert's own `Declare`. A `@Declare` inherited from a base class counts, and
 * a base that can't be inspected (ambient, factory call, mixin) is never assumed
 * to lack one.
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
				// An ambient class can't carry decorators, and a base may already be declared.
				const tsNode = services.esTreeNodeToTSNodeMap.get(node);
				if (isAmbient(tsNode) || mayInheritDeclare(checker, tsNode)) return;

				context.report({ node: node.id ?? node, messageId: 'missingDeclare' });
			};

			return {
				ClassDeclaration: checkClass,
				ClassExpression: checkClass,
			};
		},
	});
}
