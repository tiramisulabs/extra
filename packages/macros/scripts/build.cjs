function build() {
	const root = path.resolve(__dirname, '..');
	const vendor = path.join(root, 'vendor/ts-macros');
	if (!fs.existsSync(path.join(vendor, 'src/transformer.ts'))) {
		throw new Error('Initialize the engine with git submodule update --init packages/macros/vendor/ts-macros');
	}
	const output = path.join(root, 'lib');
	const program = prepareEngine(vendor, output);
	fs.rmSync(output, { recursive: true, force: true });
	fs.mkdirSync(output, { recursive: true });
	for (const file of fs.readdirSync(path.join(root, 'src')))
		fs.copyFileSync(path.join(root, 'src', file), path.join(output, file));
	const cli = path.join(output, 'cli.cjs');
	fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace(/^#!([^\r\n]+)\r?\n/, '#!$1\n'));
	fs.chmodSync(cli, 0o755);
	const result = program.emit();
	if (result.emitSkipped) throw new Error('Engine compilation failed');
	fs.copyFileSync(path.join(vendor, 'LICENSE'), path.join(output, 'engine/LICENSE'));
}
function prepareEngine(vendor, output) {
	const source = path.join(vendor, 'src');
	const files = ['index', 'transformer', 'nativeMacros', 'actions', 'utils'].map(file =>
		path.join(source, `${file}.ts`),
	);
	files.push(require.resolve('@types/ts-expose-internals/index.d.ts'));
	const program = ts.createProgram(files, {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
		rootDir: source,
		outDir: path.join(output, 'engine'),
		strict: true,
		skipLibCheck: true,
		types: ['node'],
		ignoreDeprecations: '6.0',
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	if (diagnostics.length)
		throw new Error(
			ts.formatDiagnosticsWithColorAndContext(diagnostics, {
				getCurrentDirectory: ts.sys.getCurrentDirectory,
				getCanonicalFileName: file => file,
				getNewLine: () => '\n',
			}),
		);
	return program;
}

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
build();
