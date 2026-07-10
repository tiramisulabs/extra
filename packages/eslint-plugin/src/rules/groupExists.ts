import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ESLintUtils, TSESLint, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
	constInitializer,
	extendsSeyfertClass,
	getServices,
	instanceTypeOfExpression,
	objectProperty,
	propertyName,
	resolveObjectLiteral,
	seyfertExportName,
	stringLiteralValue,
	symbolConstInitializer,
	unwrap,
} from '../utils';

type Services = NonNullable<ReturnType<typeof getServices>>;
type MessageIds = 'unknownGroup' | 'unknownGroupAutoload';
type RuleContext = Readonly<TSESLint.RuleContext<MessageIds, readonly []>>;

const COMMAND: ReadonlySet<string> = new Set(['Command']);
const SUBCOMMAND: ReadonlySet<string> = new Set(['SubCommand']);
const GROUP_DECLARERS: ReadonlySet<string> = new Set(['Groups', 'GroupsT']);

/** Whether seyfert's loader would treat this file as a command module (`.ts`, excluding `.d.ts`). */
function isSourceFile(name: string): boolean {
	return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

/** Un-alias a symbol to its original, swallowing the "not an alias here" throw. */
function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
	if (symbol.flags & ts.SymbolFlags.Alias) {
		try {
			return checker.getAliasedSymbol(symbol);
		} catch {
			return undefined;
		}
	}
	return symbol;
}

/** The class a symbol ultimately refers to, if its value declaration is a class. */
function classOfSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.ClassLikeDeclaration | undefined {
	const resolved = symbol ? unalias(checker, symbol) : undefined;
	const declaration = resolved?.valueDeclaration;
	return declaration && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
		? declaration
		: undefined;
}

/** Instance type of a class declaration/expression (for `extends` checks). */
function classInstanceType(checker: ts.TypeChecker, node: ts.ClassLikeDeclaration): ts.Type | undefined {
	if (node.name) {
		const symbol = checker.getSymbolAtLocation(node.name);
		if (symbol) {
			const declared = checker.getDeclaredTypeOfSymbol(symbol);
			if (declared.flags & ts.TypeFlags.Object) return declared;
		}
	}
	const type = checker.getTypeAtLocation(node);
	return type.getConstructSignatures()[0]?.getReturnType() ?? type;
}

/** Whether `node` is a class that extends seyfert's `SubCommand`. */
function isSubCommand(checker: ts.TypeChecker, node: ts.ClassLikeDeclaration): boolean {
	const type = classInstanceType(checker, node);
	return type !== undefined && extendsSeyfertClass(checker, type, SUBCOMMAND);
}

/**
 * The group a class is assigned to via seyfert's `@Group`, if it is a string
 * literal. Handles both the bare `@Group('x')` and the typed `@Group(defs, 'x')`
 * overload (where the name is the second argument).
 */
function groupOf(checker: ts.TypeChecker, node: ts.ClassLikeDeclaration): string | undefined {
	for (const decorator of ts.getDecorators(node) ?? []) {
		const expression = decorator.expression;
		if (!ts.isCallExpression(expression)) continue;
		if (seyfertExportName(checker, checker.getSymbolAtLocation(expression.expression)) !== 'Group') continue;
		const nameArgument = expression.arguments.length >= 2 ? expression.arguments[1] : expression.arguments[0];
		return nameArgument ? stringLiteralValue(nameArgument) : undefined;
	}
	return undefined;
}

/** The class a source file `export default`s, if any. */
function defaultExportedClass(checker: ts.TypeChecker, source: ts.SourceFile): ts.ClassLikeDeclaration | undefined {
	for (const statement of source.statements) {
		if (
			ts.isClassDeclaration(statement) &&
			statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
			statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)
		) {
			return statement;
		}
		if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
			const expression = unwrap(statement.expression);
			if (ts.isClassExpression(expression)) return expression;
			const found = classOfSymbol(checker, checker.getSymbolAtLocation(expression));
			if (found) return found;
		}
	}
	return undefined;
}

/** Resolve an expression to the array literal it refers to (through `const`/imports). */
function resolveArrayLiteral(
	checker: ts.TypeChecker,
	node: ts.Expression,
	seen: Set<ts.Node>,
): ts.ArrayLiteralExpression | undefined {
	const expression = unwrap(node);
	if (seen.has(expression)) return undefined;
	seen.add(expression);
	if (ts.isArrayLiteralExpression(expression)) return expression;
	if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
		const initializer = constInitializer(checker, expression);
		return initializer ? resolveArrayLiteral(checker, initializer, seen) : undefined;
	}
	return undefined;
}

/**
 * Resolve a `@Groups`/`@GroupsT` argument to its object literal — through
 * `const`/imports and seyfert's `defineGroups(...)` identity helper.
 */
function resolveGroupsObject(
	checker: ts.TypeChecker,
	node: ts.Expression,
	seen: Set<ts.Node>,
): ts.ObjectLiteralExpression | undefined {
	const expression = unwrap(node);
	if (seen.has(expression)) return undefined;
	seen.add(expression);
	if (ts.isObjectLiteralExpression(expression)) return expression;
	if (ts.isCallExpression(expression)) {
		// `defineGroups(x)` returns `x` unchanged — unwrap to its argument.
		if (
			seyfertExportName(checker, checker.getSymbolAtLocation(expression.expression)) === 'defineGroups' &&
			expression.arguments[0]
		) {
			return resolveGroupsObject(checker, expression.arguments[0], seen);
		}
		return undefined;
	}
	if (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)) {
		const initializer = constInitializer(checker, expression);
		return initializer ? resolveGroupsObject(checker, initializer, seen) : undefined;
	}
	return undefined;
}

/** Add the aliases declared on a single group-definition object to `groups`. */
function addAliases(checker: ts.TypeChecker, definition: ts.Expression, groups: Set<string>): void {
	const object = resolveObjectLiteral(checker, definition, new Set());
	const aliases = object ? objectProperty(object, 'aliases') : undefined;
	const array = aliases ? resolveArrayLiteral(checker, aliases, new Set()) : undefined;
	if (!array) return;
	for (const element of array.elements) {
		const alias = stringLiteralValue(element);
		if (alias !== undefined) groups.add(alias);
	}
}

/** Gather group names (keys + aliases) from a resolved group object, following spreads. */
function collectFromObject(
	checker: ts.TypeChecker,
	object: ts.ObjectLiteralExpression,
	groups: Set<string>,
	seen: Set<ts.Node>,
): void {
	if (seen.has(object)) return;
	seen.add(object);
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property)) {
			groups.add(propertyName(property.name));
			addAliases(checker, property.initializer, groups);
		} else if (ts.isShorthandPropertyAssignment(property)) {
			groups.add(property.name.text);
			const initializer = symbolConstInitializer(checker.getShorthandAssignmentValueSymbol(property));
			if (initializer) addAliases(checker, initializer, groups);
		} else if (ts.isSpreadAssignment(property)) {
			const spread = resolveGroupsObject(checker, property.expression, new Set());
			if (spread) collectFromObject(checker, spread, groups, seen);
		}
	}
}

/** The group names declared by `@Groups`/`@GroupsT` — keys plus aliases. */
function collectGroups(
	checker: ts.TypeChecker,
	services: Services,
	groupsArgument: TSESTree.Expression | undefined,
): Set<string> {
	const groups = new Set<string>();
	if (!groupsArgument) return groups;
	const tsNode = services.esTreeNodeToTSNodeMap.get(groupsArgument);
	const object = tsNode ? resolveGroupsObject(checker, tsNode as ts.Expression, new Set()) : undefined;
	if (object) collectFromObject(checker, object, groups, new Set());
	return groups;
}

/**
 * A subcommand's `@Group('x')` must reference a group declared in its parent
 * command's `@Groups`/`@GroupsT`. seyfert links subcommands to a command either
 * explicitly via `@Options([Sub, ...])` or implicitly via `@AutoLoad` (every
 * `SubCommand` default-exported from a `.ts` file in the command's directory).
 * This rule validates both: it runs from the *command* (which owns the group
 * declarations) and resolves its subcommands the same way the loader does.
 *
 * Type-aware and sound: only seyfert's own decorators are matched, only literal
 * group names are checked, and a name that is also a declared alias is accepted.
 * Group declarations are resolved through `const`/imports, spreads and
 * `defineGroups(...)`. `@AutoLoad` resolution reads the sibling source files from
 * the TypeScript program, so it is a no-op when type information or the files are
 * unavailable.
 *
 * Known limitations (conservative — these under-report, never over-report): a
 * subcommand exported as `export { X as default }`, or compiled-`.js` siblings,
 * are not resolved.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'group-exists',
		meta: {
			type: 'problem',
			docs: {
				description: "A subcommand's `@Group` must reference a group declared in the command's `@Groups`/`@GroupsT`.",
			},
			messages: {
				unknownGroup: "Group `{{group}}` is not declared in this command's `@Groups`/`@GroupsT`.",
				unknownGroupAutoload:
					"Subcommand `{{sub}}` (`{{file}}`) uses group `{{group}}`, not declared in this command's `@Groups`/`@GroupsT`.",
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			const checkCommand = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression) => {
				if (!node.superClass) return;
				const decorators = node.decorators;
				if (!decorators || decorators.length === 0) return;

				const services = getServices(context);
				if (!services) return;
				const checker = services.program.getTypeChecker();

				const superType = instanceTypeOfExpression(checker, services, node.superClass);
				if (!superType || !extendsSeyfertClass(checker, superType, COMMAND)) return;

				// Locate seyfert's own group/subcommand decorators on this command.
				let groupsArgument: TSESTree.Expression | undefined;
				let optionsArgument: TSESTree.Expression | undefined;
				let autoloadDecorator: TSESTree.Decorator | undefined;
				for (const decorator of decorators) {
					const expression = decorator.expression;
					const callee = expression.type === 'CallExpression' ? expression.callee : expression;
					const name = seyfertExportName(checker, services.getSymbolAtLocation(callee));
					if (name === undefined) continue;
					if (expression.type !== 'CallExpression') {
						if (name === 'AutoLoad') autoloadDecorator = decorator;
						continue;
					}
					const argument = expression.arguments[0];
					const expressionArgument = argument && argument.type !== 'SpreadElement' ? argument : undefined;
					if (GROUP_DECLARERS.has(name)) groupsArgument = expressionArgument;
					else if (name === 'Options') optionsArgument = expressionArgument;
					else if (name === 'AutoLoad') autoloadDecorator = decorator;
				}

				if (!optionsArgument && !autoloadDecorator) return; // no discoverable subcommands

				const validGroups = collectGroups(checker, services, groupsArgument);

				if (optionsArgument) checkOptions(context, services, checker, optionsArgument, validGroups);
				if (autoloadDecorator) checkAutoload(context, services, checker, autoloadDecorator, validGroups);
			};

			return { ClassDeclaration: checkCommand, ClassExpression: checkCommand };
		},
	});
}

/** Mode A — subcommands registered explicitly through `@Options([Sub, ...])`. */
function checkOptions(
	context: RuleContext,
	services: Services,
	checker: ts.TypeChecker,
	optionsArgument: TSESTree.Expression,
	validGroups: Set<string>,
): void {
	// Inline array literal: report precisely on the offending subcommand reference.
	if (optionsArgument.type === 'ArrayExpression') {
		for (const element of optionsArgument.elements) {
			if (!element || element.type === 'SpreadElement') continue;
			const subClass = classOfSymbol(checker, services.getSymbolAtLocation(element));
			if (!subClass || !isSubCommand(checker, subClass)) continue;
			const group = groupOf(checker, subClass);
			if (group !== undefined && !validGroups.has(group)) {
				context.report({ node: element, messageId: 'unknownGroup', data: { group } });
			}
		}
		return;
	}

	// `const subs = [Sub, ...]; @Options(subs)` — report on the `@Options` argument.
	const tsNode = services.esTreeNodeToTSNodeMap.get(optionsArgument);
	const array = tsNode ? resolveArrayLiteral(checker, tsNode as ts.Expression, new Set()) : undefined;
	if (!array) return;
	for (const element of array.elements) {
		const subClass = classOfSymbol(checker, checker.getSymbolAtLocation(element));
		if (!subClass || !isSubCommand(checker, subClass)) continue;
		const group = groupOf(checker, subClass);
		if (group !== undefined && !validGroups.has(group)) {
			context.report({ node: optionsArgument, messageId: 'unknownGroup', data: { group } });
		}
	}
}

/** Mode B — subcommands discovered by `@AutoLoad` from the command's directory. */
function checkAutoload(
	context: RuleContext,
	services: Services,
	checker: ts.TypeChecker,
	autoloadDecorator: TSESTree.Decorator,
	validGroups: Set<string>,
): void {
	const commandFile = context.filename;
	const directory = dirname(commandFile);

	let entries: string[];
	try {
		entries = readdirSync(directory, { recursive: true, encoding: 'utf8' });
	} catch {
		return;
	}

	for (const entry of entries) {
		const absolute = join(directory, entry);
		if (absolute === commandFile || !isSourceFile(absolute) || entry.includes('node_modules')) continue;

		const source =
			services.program.getSourceFile(absolute) ?? services.program.getSourceFile(absolute.replace(/\\/g, '/'));
		if (!source) continue;

		const subClass = defaultExportedClass(checker, source);
		if (!subClass || !isSubCommand(checker, subClass)) continue;

		const group = groupOf(checker, subClass);
		if (group === undefined || validGroups.has(group)) continue;

		context.report({
			node: autoloadDecorator,
			messageId: 'unknownGroupAutoload',
			data: { group, sub: subClass.name?.text ?? '(default export)', file: entry.replace(/\\/g, '/') },
		});
	}
}
