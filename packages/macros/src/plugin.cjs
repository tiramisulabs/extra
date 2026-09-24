module.exports = function init({ typescript: ts }) {
	return {
		create(info) {
			const host = info.languageServiceHost;
			const { expand } = require('./transform.cjs');
			let version;
			let expansion = { files: new Map(), diagnostics: [] };
			function refresh() {
				const next = JSON.stringify([
					host.getProjectVersion?.(),
					host.getScriptFileNames().map(file => [file, host.getScriptVersion(file)]),
				]);
				if (next === version) return;
				const options = host.getCompilationSettings();
				const compilerHost = ts.createCompilerHost(options, true);
				const getSourceFile = compilerHost.getSourceFile.bind(compilerHost);
				compilerHost.getSourceFile = (file, languageVersion, ...args) => {
					const snapshot = host.getScriptSnapshot(file);
					return snapshot
						? ts.createSourceFile(file, snapshot.getText(0, snapshot.getLength()), languageVersion, true)
						: getSourceFile(file, languageVersion, ...args);
				};
				expansion = expand(ts.createProgram(host.getScriptFileNames(), options, compilerHost), ts, false);
				version = next;
			}
			const virtualHost = {
				getCompilationSettings: () => host.getCompilationSettings(),
				getScriptFileNames: () => host.getScriptFileNames(),
				getScriptVersion(file) {
					refresh();
					return `${host.getScriptVersion(file)}:${version}`;
				},
				getProjectVersion() {
					refresh();
					return version;
				},
				getScriptSnapshot(file) {
					refresh();
					const entry = expansion.files.get(file);
					return entry ? ts.ScriptSnapshot.fromString(entry.text) : host.getScriptSnapshot(file);
				},
				getCurrentDirectory: () => host.getCurrentDirectory(),
				getDefaultLibFileName: options => host.getDefaultLibFileName(options),
				fileExists: file => host.fileExists?.(file) ?? ts.sys.fileExists(file),
				readFile: file => host.readFile?.(file) ?? ts.sys.readFile(file),
				readDirectory: (...args) => ts.sys.readDirectory(...args),
				directoryExists: directory => ts.sys.directoryExists(directory),
				getDirectories: directory => ts.sys.getDirectories(directory),
			};
			const service = ts.createLanguageService(virtualHost);
			const proxy = {};
			for (const key of Object.keys(info.languageService)) proxy[key] = (...args) => info.languageService[key](...args);
			function span(file, value) {
				return value && (expansion.files.get(file)?.span(value) ?? value);
			}
			function definition(value) {
				return {
					...value,
					textSpan: span(value.fileName, value.textSpan),
					contextSpan: span(value.fileName, value.contextSpan),
				};
			}
			for (const name of ['getSemanticDiagnostics', 'getSyntacticDiagnostics', 'getSuggestionDiagnostics']) {
				proxy[name] = file => {
					refresh();
					const diagnostics = service[name](file).map(item => {
						const entry = item.file && expansion.files.get(item.file.fileName);
						if (!entry || item.start === undefined) return item;
						const mapped = entry.span({ start: item.start, length: item.length ?? 0 });
						return { ...item, file: entry.source, start: mapped.start, length: mapped.length };
					});
					return name === 'getSemanticDiagnostics'
						? [...diagnostics, ...expansion.diagnostics.filter(item => item.file.fileName === file)]
						: diagnostics;
				};
			}
			for (const name of [
				'getQuickInfoAtPosition',
				'getCompletionsAtPosition',
				'getCompletionEntryDetails',
				'getSignatureHelpItems',
				'getDefinitionAtPosition',
				'getDefinitionAndBoundSpan',
				'getTypeDefinitionAtPosition',
			]) {
				proxy[name] = (file, position, ...args) => {
					refresh();
					const result = service[name](file, expansion.files.get(file)?.toGenerated(position) ?? position, ...args);
					if (!result) return result;
					if (Array.isArray(result)) return result.map(definition);
					return {
						...result,
						...(result.textSpan && { textSpan: span(file, result.textSpan) }),
						...(result.applicableSpan && { applicableSpan: span(file, result.applicableSpan) }),
						...(result.optionalReplacementSpan && {
							optionalReplacementSpan: span(file, result.optionalReplacementSpan),
						}),
						...(result.entries && {
							entries: result.entries.map(entry => ({
								...entry,
								...(entry.replacementSpan && { replacementSpan: span(file, entry.replacementSpan) }),
							})),
						}),
						...(result.definitions && { definitions: result.definitions.map(definition) }),
					};
				};
			}
			proxy.dispose = () => {
				service.dispose();
				info.languageService.dispose();
			};
			return proxy;
		},
	};
};
