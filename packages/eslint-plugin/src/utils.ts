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
