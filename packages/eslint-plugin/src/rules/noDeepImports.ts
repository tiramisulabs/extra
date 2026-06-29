import type { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import { getServices } from '../utils';

const DEEP_IMPORT = /^seyfert\/lib\//;

// Cache the set of names exported from the `seyfert` package root, keyed by the
// resolved root declaration file. Expanding `export *` requires a type checker,
// so this is computed once and reused across the whole lint run.
const rootExportsCache = new Map<string, Set<string>>();

function seyfertRootExports(program: ts.Program, fromFile: string): Set<string> {
	const options = program.getCompilerOptions();
	const resolved = ts.resolveModuleName('seyfert', fromFile, options, ts.sys).resolvedModule?.resolvedFileName;
	if (!resolved) return new Set();

	const cached = rootExportsCache.get(resolved);
	if (cached) return cached;

	let checker = program.getTypeChecker();
	let sourceFile = program.getSourceFile(resolved);
	if (!sourceFile) {
		// Root index isn't in the linted program (the file only imports deep
		// paths). Build a tiny throwaway program just to read its exports.
		const mini = ts.createProgram([resolved], { ...options, noEmit: true, skipLibCheck: true });
		checker = mini.getTypeChecker();
		sourceFile = mini.getSourceFile(resolved);
	}

	const names = new Set<string>();
	const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
	if (moduleSymbol) {
		for (const exported of checker.getExportsOfModule(moduleSymbol)) names.add(exported.getName());
	}
	rootExportsCache.set(resolved, names);
	return names;
}

const importedName = (specifier: TSESTree.ImportSpecifier): string =>
	specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);

/**
 * Flag `import { X } from 'seyfert/lib/...'` when `X` is also exported from the
 * `seyfert` package root. Type-aware: the root export surface is read from the
 * real seyfert types (expanding `export *`), so symbols that genuinely only
 * live deep (e.g. `CommandHandler`, `HandleCommand`) are never flagged.
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'no-deep-imports',
		meta: {
			type: 'suggestion',
			fixable: 'code',
			docs: {
				description:
					'Prefer the `seyfert` package root over deep `seyfert/lib/...` paths when the symbol is re-exported from root.',
			},
			messages: {
				preferRoot: "'{{name}}' is exported from 'seyfert'; import it from the package root, not '{{source}}'.",
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			return {
				ImportDeclaration(node) {
					const source = node.source.value;
					if (typeof source !== 'string' || !DEEP_IMPORT.test(source)) return;

					const services = getServices(context);
					if (!services) return;

					const rootExports = seyfertRootExports(services.program, context.filename);
					if (rootExports.size === 0) return;

					const named = node.specifiers.filter(
						(specifier): specifier is TSESTree.ImportSpecifier => specifier.type === 'ImportSpecifier',
					);
					const offending = named.filter(specifier => rootExports.has(importedName(specifier)));
					if (offending.length === 0) return;

					// Safe to rewrite the whole source only when every specifier is a
					// named import that root also provides (no default/namespace, no
					// deep-only leftovers).
					const allRootAvailable = node.specifiers.length === named.length && offending.length === named.length;

					offending.forEach((specifier, index) => {
						context.report({
							node: specifier,
							messageId: 'preferRoot',
							data: { name: importedName(specifier), source },
							fix: allRootAvailable && index === 0 ? fixer => fixer.replaceText(node.source, "'seyfert'") : undefined,
						});
					});
				},
			};
		},
	});
}
