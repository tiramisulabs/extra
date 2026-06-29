import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import { getServices, isSeyfertSymbol, seyfertExportName } from '../utils';

const OPTION_BUILDER = /^create[A-Za-z]*Option$/;

interface Violation {
	node: ts.Node;
	name: string;
}

/** Strip `as`, `satisfies`, parentheses and `!` to reach the underlying expression. */
function unwrap(node: ts.Expression): ts.Expression {
	let current = node;
	while (
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

/** The initializer of the `const` a symbol points at, if any. */
function symbolConstInitializer(symbol: ts.Symbol | undefined): ts.Expression | undefined {
	const declaration = symbol?.valueDeclaration;
	if (
		declaration &&
		ts.isVariableDeclaration(declaration) &&
		declaration.initializer &&
		declaration.parent.flags & ts.NodeFlags.Const
	) {
		return declaration.initializer;
	}
	return undefined;
}

/** The `const` initializer an identifier/property-access refers to, across imports. */
function constInitializer(checker: ts.TypeChecker, node: ts.Expression): ts.Expression | undefined {
	let symbol = checker.getSymbolAtLocation(node);
	if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
		try {
			symbol = checker.getAliasedSymbol(symbol);
		} catch {
			return undefined;
		}
	}
	return symbolConstInitializer(symbol);
}

/**
 * Resolve an expression to the object literal it ultimately refers to — through
 * `const` bindings and imports. Returns undefined for arrays, parameters,
 * computed values, or anything not statically resolvable.
 */
function resolveObjectLiteral(
	checker: ts.TypeChecker,
	node: ts.Expression,
	seen: Set<ts.Node>,
): ts.ObjectLiteralExpression | undefined {
	const expression = unwrap(node);
	if (seen.has(expression)) return undefined;
	seen.add(expression);

	if (ts.isObjectLiteralExpression(expression)) return expression;
	if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined;

	const initializer = constInitializer(checker, expression);
	return initializer ? resolveObjectLiteral(checker, initializer, seen) : undefined;
}

function propertyName(name: ts.PropertyName): string {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : 'option';
}

/**
 * Walk an options object literal and collect every value that is NOT a seyfert
 * `createXOption` builder call. Follows `const`/import references and spreads,
 * and verifies builder origin by type (un-aliased symbol must live in seyfert).
 */
function collectViolations(checker: ts.TypeChecker, root: ts.ObjectLiteralExpression): Violation[] {
	const violations: Violation[] = [];
	const seen = new Set<ts.Node>();

	const isSeyfertBuilderCall = (value: ts.Expression): boolean => {
		if (!ts.isCallExpression(value)) return false;
		const name = seyfertExportName(checker, checker.getSymbolAtLocation(value.expression));
		return name !== undefined && OPTION_BUILDER.test(name);
	};

	const checkValue = (value: ts.Expression, name: string): void => {
		const expression = unwrap(value);
		if (isSeyfertBuilderCall(expression)) return;
		// A reference to a const that holds a builder result (`const q = createX(); { q }`).
		if (ts.isIdentifier(expression) && !seen.has(expression)) {
			seen.add(expression);
			const initializer = constInitializer(checker, expression);
			if (initializer) {
				checkValue(initializer, name);
				return;
			}
		}
		violations.push({ node: value, name });
	};

	const checkObject = (object: ts.ObjectLiteralExpression): void => {
		if (seen.has(object) && object !== root) return;
		seen.add(object);
		for (const property of object.properties) {
			if (ts.isPropertyAssignment(property)) {
				checkValue(property.initializer, propertyName(property.name));
			} else if (ts.isShorthandPropertyAssignment(property)) {
				const initializer = symbolConstInitializer(checker.getShorthandAssignmentValueSymbol(property));
				if (initializer) checkValue(initializer, property.name.text);
				else violations.push({ node: property, name: property.name.text });
			} else if (ts.isSpreadAssignment(property)) {
				const spread = resolveObjectLiteral(checker, property.expression, seen);
				if (spread) checkObject(spread);
			} else {
				violations.push({ node: property, name: propertyName(property.name) });
			}
		}
	};

	checkObject(root);
	return violations;
}

/**
 * Inside a seyfert `@Options({ ... })` decorator, every option value must be
 * produced by a seyfert `createXOption` builder.
 *
 * Detection is syntactic (the value must be a builder *call*) but resolves
 * through the TypeScript program, so it follows `const` bindings AND records
 * imported from other files. The builder origin is verified by type: the callee
 * must come from seyfert, and only seyfert. The array form `@Options([Sub, ...])`
 * (subcommands) is left untouched.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'options-use-builders',
		meta: {
			type: 'problem',
			docs: {
				description: 'Seyfert command options must be created with a `createXOption` builder.',
			},
			messages: {
				useBuilder:
					"Option '{{name}}' must be created with a seyfert `createXOption` builder (e.g. `createStringOption`).",
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				Decorator(node) {
					const expression = node.expression;
					if (expression.type !== 'CallExpression') return;

					const services = getServices(context);
					if (!services) return;
					const checker = services.program.getTypeChecker();

					// Only seyfert's own `Options` decorator (verified by package origin).
					if (!isSeyfertSymbol(checker, services.getSymbolAtLocation(expression.callee), 'Options')) return;

					const argument = expression.arguments[0];
					if (!argument || argument.type === 'SpreadElement') return;

					const argumentTsNode = services.esTreeNodeToTSNodeMap.get(argument);
					if (!argumentTsNode) return;

					const optionsObject = resolveObjectLiteral(checker, argumentTsNode as ts.Expression, new Set());
					if (!optionsObject) return; // array form, computed, or not statically resolvable

					for (const violation of collectViolations(checker, optionsObject)) {
						// Report on the offending value when it lives in this file, otherwise
						// on the `@Options(...)` argument (e.g. the record is imported).
						const reportNode =
							(services.tsNodeToESTreeNodeMap.get(violation.node) as TSESTree.Node | undefined) ?? argument;
						context.report({ node: reportNode, messageId: 'useBuilder', data: { name: violation.name } });
					}
				},
			};
		},
	});
}
