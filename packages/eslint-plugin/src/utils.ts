import {
	ESLintUtils,
	type ParserServicesWithTypeInformation,
	type TSESLint,
	type TSESTree,
} from '@typescript-eslint/utils';
import * as ts from 'typescript';

type AnyContext = Readonly<TSESLint.RuleContext<string, readonly unknown[]>>;
type Services = ParserServicesWithTypeInformation;

/** A declaration file that lives inside the installed `seyfert` package. */
const SEYFERT_DECL = /[\\/]seyfert[\\/]lib[\\/]/;

/**
 * Parser services backed by a real TypeScript program, or `null` when type
 * information is unavailable. Type-aware rules degrade to no-op without it
 * instead of throwing.
 */
export function getServices(context: AnyContext): Services | null {
	try {
		const services = ESLintUtils.getParserServices(context, true);
		return services.program ? (services as unknown as Services) : null;
	} catch {
		return null;
	}
}

/** Follow re-exports to the symbol's original declaration. */
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	if (symbol.flags & ts.SymbolFlags.Alias) {
		try {
			return checker.getAliasedSymbol(symbol);
		} catch {
			/* not actually an alias at this position */
		}
	}
	return symbol;
}

/**
 * Whether `symbol` — after un-aliasing any re-export — is declared inside the
 * `seyfert` package. Optionally also require an exact symbol name. This is the
 * guard that stops a rule from confusing seyfert's `Command`/`Declare`/… with a
 * same-named symbol from any other package.
 */
export function isSeyfertSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined, name?: string): boolean {
	const exportName = seyfertExportName(checker, symbol);
	return exportName !== undefined && (name === undefined || exportName === name);
}

/**
 * If `symbol` — after un-aliasing re-exports — is declared inside the `seyfert`
 * package, return its original export name; otherwise `undefined`. Lets callers
 * match a family of exports (e.g. every `createXOption`) by package origin.
 */
export function seyfertExportName(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | undefined {
	if (!symbol) return undefined;
	const original = unalias(checker, symbol);
	const fromSeyfert = (original.getDeclarations() ?? []).some(decl => SEYFERT_DECL.test(decl.getSourceFile().fileName));
	return fromSeyfert ? original.getName() : undefined;
}

/** Resolve the instance type behind a heritage expression (`extends X`). */
export function instanceTypeOfExpression(
	checker: ts.TypeChecker,
	services: Services,
	expression: TSESTree.Expression,
): ts.Type | undefined {
	const symbol = services.getSymbolAtLocation(expression);
	if (symbol) {
		const declared = checker.getDeclaredTypeOfSymbol(unalias(checker, symbol));
		if (declared && declared.flags & ts.TypeFlags.Object) return declared;
	}
	const type = services.getTypeAtLocation(expression);
	return type.getConstructSignatures()[0]?.getReturnType() ?? type;
}

/** Seyfert base classes that carry the command lifecycle / `@Declare` contract. */
const COMMAND_BASES = new Set(['BaseCommand', 'Command', 'SubCommand', 'ContextMenuCommand', 'EntryPointCommand']);

/**
 * Walk the base-type chain of `type` and report whether any ancestor is a
 * seyfert class whose name is in `names` (verified by both name and package
 * origin).
 */
export function extendsSeyfertClass(checker: ts.TypeChecker, type: ts.Type, names: ReadonlySet<string>): boolean {
	const seen = new Set<ts.Type>();
	const stack: ts.Type[] = [type];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || seen.has(current)) continue;
		seen.add(current);
		const symbol = current.aliasSymbol ?? current.getSymbol();
		if (symbol && names.has(symbol.getName()) && isSeyfertSymbol(checker, symbol)) return true;
		for (const base of current.getBaseTypes() ?? []) stack.push(base);
	}
	return false;
}

/** Whether `type` extends any seyfert command base (`Command`, `SubCommand`, …). */
export function extendsSeyfertCommand(checker: ts.TypeChecker, type: ts.Type): boolean {
	return extendsSeyfertClass(checker, type, COMMAND_BASES);
}

/**
 * Whether a class/method node carries a decorator whose callee resolves to the
 * seyfert export named `name` (e.g. `@Declare(...)` → `Declare`).
 */
export function hasSeyfertDecorator(
	checker: ts.TypeChecker,
	services: Services,
	decorators: TSESTree.Decorator[] | undefined,
	name: string,
): boolean {
	for (const decorator of decorators ?? []) {
		const expression = decorator.expression;
		const callee = expression.type === 'CallExpression' ? expression.callee : expression;
		if (isSeyfertSymbol(checker, services.getSymbolAtLocation(callee), name)) return true;
	}
	return false;
}

/** Strip `as`, `satisfies`, parentheses and `!` to reach the underlying expression. */
export function unwrap(node: ts.Expression): ts.Expression {
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
export function symbolConstInitializer(symbol: ts.Symbol | undefined): ts.Expression | undefined {
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
export function constInitializer(checker: ts.TypeChecker, node: ts.Expression): ts.Expression | undefined {
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
export function resolveObjectLiteral(
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

/** The text of an object-literal property name (identifier/string/number key). */
export function propertyName(name: ts.PropertyName): string {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	if (ts.isComputedPropertyName(name)) {
		const expression = name.expression;
		if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
	}
	return 'option';
}

/** The value expression of a `name: <value>` (or shorthand `name`) property, if present. */
export function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.initializer;
		}
		if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
			return property.name;
		}
	}
	return undefined;
}

/** The static string value of `expr` if it is a string literal (after unwrapping). */
export function stringLiteralValue(expr: ts.Expression): string | undefined {
	const node = unwrap(expr);
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

/** The static boolean value of `expr` if it is a `true`/`false` literal (after unwrapping). */
export function booleanLiteralValue(expr: ts.Expression): boolean | undefined {
	const node = unwrap(expr);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	return undefined;
}

/** Seyfert option builders are `createXOption` (e.g. `createStringOption`). */
const OPTION_BUILDER = /^create[A-Za-z]*Option$/;

/**
 * If `expr` is a call to a seyfert `createXOption` builder (verified by package
 * origin), return the builder name; otherwise undefined.
 */
export function seyfertOptionBuilderName(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
	const node = unwrap(expr);
	if (!ts.isCallExpression(node)) return undefined;
	const name = seyfertExportName(checker, checker.getSymbolAtLocation(node.expression));
	return name !== undefined && OPTION_BUILDER.test(name) ? name : undefined;
}
