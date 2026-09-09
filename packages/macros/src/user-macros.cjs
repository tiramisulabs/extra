function userMacros(program, ts) {
	const { MacroTransformer } = require('./engine/transformer.js');
	const checker = program.getTypeChecker();
	const macros = new Map();
	const diagnostics = [];
	function isMacroFunction(node) {
		return ts.isFunctionDeclaration(node) && node.name?.text.startsWith('$') && !!node.body;
	}
	function containsMacro(source) {
		function visit(node) {
			if (isMacroFunction(node)) return true;
			if (ts.isCallExpression(node) && ts.isNonNullExpression(node.expression)) {
				let symbol = checker.getSymbolAtLocation(node.expression.expression);
				if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
				if (symbol?.declarations?.some(isMacroFunction)) return true;
			}
			return ts.forEachChild(node, visit);
		}
		return !!visit(source);
	}
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile) continue;
		function validate(node) {
			if (ts.isIdentifier(node)) {
				let symbol = checker.getSymbolAtLocation(node);
				if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
				if (symbol?.declarations?.some(isMacroFunction)) {
					const owner = node.parent;
					const declaration = isMacroFunction(owner) && owner.name === node;
					const imported = ts.isImportSpecifier(owner) || ts.isImportClause(owner);
					const expression = ts.isPropertyAccessExpression(owner) && owner.name === node ? owner : node;
					const call = expression.parent;
					const invocation =
						node.text.startsWith('$') &&
						ts.isNonNullExpression(call) &&
						ts.isCallExpression(call.parent) &&
						call.parent.expression === call;
					if (!declaration && !imported && !invocation)
						diagnostics.push({
							file: source,
							start: node.getStart(source),
							length: node.getWidth(source),
							category: ts.DiagnosticCategory.Error,
							code: 99002,
							messageText:
								'Macro functions are compile-time only. Invoke them as $name!(); runtime references and re-export bindings are not supported.',
						});
				}
			}
			ts.forEachChild(node, validate);
		}
		validate(source);
	}
	return {
		diagnostics,
		before: [
			context => {
				const transformer = new MacroTransformer(context, checker, macros, { keepImports: true });
				return source => {
					if (!containsMacro(source)) return source;
					return transformer.run(source);
				};
			},
		],
		afterDeclarations: [
			context => {
				function visit(node) {
					// Macro implementation functions are compile-time only, not runtime exports.
					if (isMacroFunction(ts.getOriginalNode(node))) return undefined;
					return ts.visitEachChild(node, visit, context);
				}
				return source => ts.visitNode(source, visit);
			},
		],
	};
}
module.exports = { userMacros };
