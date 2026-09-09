function expand(program, ts, emit) {
	const { contextType } = require('./contexts.cjs');
	const { extensionTypes } = require('./extensions.cjs');
	const checker = program.getTypeChecker();
	const files = new Map();
	const diagnostics = [];
	function symbolAt(node) {
		const symbol = checker.getSymbolAtLocation(node);
		return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
	}
	function exportsOf(file) {
		const symbol = file && checker.getSymbolAtLocation(file);
		return new Map(
			symbol
				? checker
						.getExportsOfModule(symbol)
						.map(item => [item.name, item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item])
				: [],
		);
	}
	const markerExports = exportsOf(program.getSourceFile(require.resolve('./context.d.ts')));
	const contextSymbol = markerExports.get('Context');
	const guildSymbol = markerExports.get('GuildContext');
	const markerSymbols = new Set([contextSymbol, guildSymbol].filter(Boolean));
	if (!markerSymbols.size) return { files, diagnostics };
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile) continue;
		const module = ts.resolveModuleName(
			'seyfert',
			source.fileName,
			program.getCompilerOptions(),
			ts.sys,
		).resolvedModule;
		const seyfert = exportsOf(module && program.getSourceFile(module.resolvedFileName));
		const edits = [];
		function fail(node, message) {
			diagnostics.push({
				file: source,
				start: node.getStart(source),
				length: node.getWidth(source),
				category: ts.DiagnosticCategory.Error,
				code: 99001,
				messageText: message,
			});
		}
		function visit(node) {
			const decorators = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
			const markers = decorators.filter(
				item => ts.isCallExpression(item.expression) && markerSymbols.has(symbolAt(item.expression.expression)),
			);
			if (markers.length) {
				const marker = markers[0];
				const guild = symbolAt(marker.expression.expression) === guildSymbol;
				const owner = node.parent;
				const base =
					ts.isClassDeclaration(owner) &&
					owner.heritageClauses?.find(item => item.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
				const baseSymbol = base && symbolAt(base.expression);
				const family =
					baseSymbol &&
					['Command', 'SubCommand', 'ComponentCommand', 'ModalCommand', 'ContextMenuCommand', 'EntryPointCommand'].find(
						name => seyfert.get(name) === baseSymbol,
					);
				const method = ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
				if (guild && method === 'onInternalError') {
					fail(marker, '@GuildContext() requires an interaction context; onInternalError receives a client.');
					return;
				}
				const hooks = [
					'run',
					'filter',
					'onBeforeOptions',
					'onBeforeMiddlewares',
					'onAfterRun',
					'onRunError',
					'onOptionsError',
					'onMiddlewaresError',
					'onBotPermissionsFail',
					'onPermissionsFail',
					'onInternalError',
				];
				const member = family && method && checker.getDeclaredTypeOfSymbol(baseSymbol).getProperty(method);
				const signature =
					member && checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(member, base)).getCallSignatures()[0];
				if (
					!family ||
					!method ||
					!hooks.includes(method) ||
					!signature ||
					!node.body ||
					!node.parameters.length ||
					node.parameters.length > signature.parameters.length ||
					node.parameters.some(
						parameter => !ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer,
					) ||
					node.parameters[0]?.type ||
					node.parameters[0]?.questionToken ||
					node.modifiers?.some(item => item.kind === ts.SyntaxKind.StaticKeyword) ||
					markers.length !== 1 ||
					marker.expression.arguments.length
				) {
					fail(
						marker,
						`@${guild ? 'GuildContext' : 'Context'}() requires an existing handler or hook on a direct Seyfert subclass, with an untyped first parameter.`,
					);
					return;
				}
				let options = '{}';
				let middlewares = 'never';
				const componentProperty = checker.getTypeAtLocation(owner).getProperty('componentType');
				const component = componentProperty && checker.getTypeOfSymbolAtLocation(componentProperty, owner);
				const kinds = component?.isUnion() ? component.types : component ? [component] : [];
				const componentType =
					kinds.length && kinds.every(kind => kind.isStringLiteral())
						? kinds.map(kind => JSON.stringify(kind.value)).join(' | ')
						: "keyof import('seyfert').ContextComponentCommandInteractionMap";
				let menuInteraction = "import('seyfert').UserCommandInteraction | import('seyfert').MessageCommandInteraction";
				let valid = true;
				const seen = new Set();
				for (const decorator of ts.getDecorators(owner) ?? []) {
					const call = decorator.expression;
					if (!ts.isCallExpression(call)) continue;
					const symbol = symbolAt(call.expression);
					if (family === 'ContextMenuCommand' && symbol === seyfert.get('Declare') && call.arguments[0]) {
						const declaration = checker.getTypeAtLocation(call.arguments[0]);
						const field = declaration.getProperty('type');
						const value = field && checker.getTypeOfSymbolAtLocation(field, call.arguments[0]);
						if (value?.isNumberLiteral() && value.value === 2)
							menuInteraction = "import('seyfert').UserCommandInteraction";
						else if (value?.isNumberLiteral() && value.value === 3)
							menuInteraction = "import('seyfert').MessageCommandInteraction";
					}
					const kind =
						symbol && symbol === seyfert.get('Options')
							? 'Options'
							: symbol && symbol === seyfert.get('Middlewares')
								? 'Middlewares'
								: undefined;
					if (!kind) continue;
					const argument = call.arguments[0];
					if (
						argument &&
						ts.isIdentifier(argument) &&
						node.parameters.some(parameter => argument.text === parameter.name.text)
					) {
						fail(node, 'Method parameter must not shadow the options or middleware declaration.');
						valid = false;
						continue;
					}
					if (seen.has(kind) || call.arguments.length !== 1) {
						fail(decorator, `@${kind} must occur once with one argument.`);
						valid = false;
						continue;
					}
					seen.add(kind);
					if (kind === 'Options') {
						if (!['Command', 'SubCommand'].includes(family)) {
							fail(decorator, '@Options is only supported for chat commands.');
							valid = false;
							continue;
						}
						if (!ts.isIdentifier(argument)) {
							fail(argument, 'Use @Options(namedOptions).');
							valid = false;
						} else options = `typeof ${argument.text}`;
					} else if (ts.isIdentifier(argument)) middlewares = `(typeof ${argument.text})[number]`;
					else if (ts.isArrayLiteralExpression(argument) && argument.elements.every(ts.isStringLiteral)) {
						middlewares = argument.elements.map(item => JSON.stringify(item.text)).join(' | ') || 'never';
					} else {
						fail(argument, 'Use a literal middleware array or a named tuple.');
						valid = false;
					}
				}
				if (valid) {
					const baseContext = contextType({
						family,
						method,
						options,
						middlewares,
						menuInteraction,
						componentType,
						guild,
					});
					const additions =
						method === 'onInternalError'
							? []
							: extensionTypes(owner, node, checker, ts, markerExports.get('ContextExtension'), fail);
					const context = [baseContext, ...additions.map(type => `(${type})`)].join(' & ');
					for (const [index, parameter] of node.parameters.entries()) {
						if (parameter.type) continue;
						const type =
							index === 0 && method !== 'onInternalError'
								? context
								: `Parameters<NonNullable<import('seyfert').${family}['${method}']>>[${index}]`;
						edits.push({ position: parameter.questionToken?.end ?? parameter.name.end, text: `: ${type}` });
					}
					if (emit)
						edits.push({
							position: marker.getStart(source),
							end: marker.end,
							text: source.text.slice(marker.getStart(source), marker.end).replace(/[^\r\n]/g, ' '),
						});
				}
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
		if (!edits.length) continue;
		if (emit) {
			for (const statement of source.statements) {
				if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly)
					continue;
				const clause = statement.importClause;
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamedImports(bindings)) {
					const markers = bindings.elements.filter(item => !item.isTypeOnly && markerSymbols.has(symbolAt(item.name)));
					if (!markers.length) continue;
					if (!clause.name && bindings.elements.every(item => item.isTypeOnly || markers.includes(item))) {
						edits.push({ position: clause.getStart(source), text: 'type ' });
					} else for (const marker of markers) edits.push({ position: marker.getStart(source), text: 'type ' });
				} else if (bindings && ts.isNamespaceImport(bindings)) {
					const moduleSymbol = symbolAt(bindings.name);
					if (moduleSymbol && checker.getExportsOfModule(moduleSymbol).some(item => markerSymbols.has(item))) {
						edits.push({ position: clause.getStart(source), text: 'type ' });
					}
				}
			}
		}
		edits.sort((a, b) => a.position - b.position);
		let text = source.text;
		for (const edit of [...edits].reverse())
			text = text.slice(0, edit.position) + edit.text + text.slice(edit.end ?? edit.position);
		const insertions = edits.filter(edit => edit.end === undefined);
		function toGenerated(position) {
			return (
				position + insertions.filter(edit => edit.position <= position).reduce((sum, edit) => sum + edit.text.length, 0)
			);
		}
		function toOriginal(position) {
			let shift = 0;
			for (const edit of insertions) {
				const start = edit.position + shift;
				if (position < start) break;
				if (position < start + edit.text.length) return edit.position;
				shift += edit.text.length;
			}
			return position - shift;
		}
		function span(span) {
			const start = toOriginal(span.start);
			return { start, length: Math.max(0, toOriginal(span.start + span.length) - start) };
		}
		files.set(source.fileName, { source, text, toGenerated, toOriginal, span });
	}
	return { files, diagnostics };
}
module.exports = { expand };
