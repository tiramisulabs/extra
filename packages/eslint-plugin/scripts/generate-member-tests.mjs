// Generates one ESLint rule-tester case per method / getter / property of every
// seyfert class and writes them into test/noMethodDestructure.test.mts at the
// `// __GEN_INVALID__` (methods) and `// __GEN_VALID__` (getters/properties)
// markers.
//
//   node scripts/generate-member-tests.mjs
//
// Each case destructures the member off a typed value and asserts the rule's
// behaviour: a method is flagged (invalid), a getter/property/function-field is
// not (valid). `InstanceType<typeof Class>` is used so generic classes resolve.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const entryPath = join(packageDir, '__gen_entry__.ts');
const testPath = join(packageDir, 'test', 'noMethodDestructure.test.mts');
const SEYFERT = /[\\/]seyfert[\\/]lib[\\/]/;

writeFileSync(entryPath, "export * from 'seyfert';\n");
let classes;
try {
	const program = ts.createProgram([entryPath], {
		module: ts.ModuleKind.CommonJS,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		target: ts.ScriptTarget.ESNext,
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		esModuleInterop: true,
		experimentalDecorators: true,
		types: [],
	});
	const checker = program.getTypeChecker();
	const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entryPath));
	classes = [];
	for (const exp of checker.getExportsOfModule(moduleSymbol)) {
		const symbol = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
		const classDecl = (symbol.getDeclarations() ?? []).find(d => ts.isClassDeclaration(d) || ts.isClassExpression(d));
		if (!classDecl || !SEYFERT.test(classDecl.getSourceFile().fileName)) continue;

		const members = [];
		for (const prop of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) {
			const name = prop.getName();
			if (name.startsWith('__') || name.startsWith('#') || name.startsWith('_')) continue;
			const decls = prop.getDeclarations() ?? [];
			if (!decls.some(d => SEYFERT.test(d.getSourceFile().fileName))) continue;

			let isMethod = false;
			if (decls.some(d => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d))) isMethod = false;
			else if (decls.some(d => ts.isMethodDeclaration(d) || ts.isMethodSignature(d))) isMethod = true;
			members.push({ name, isMethod });
		}
		members.sort((a, b) => a.name.localeCompare(b.name));
		classes.push({ name: symbol.getName(), members });
	}
	classes.sort((a, b) => a.name.localeCompare(b.name));
} finally {
	unlinkSync(entryPath);
}

const s = JSON.stringify;
const codeFor = (className, member) =>
	`import { ${className} } from 'seyfert';\ndeclare const value: InstanceType<typeof ${className}>;\nconst { ${member}: _v } = value;`;

const valid = [];
const invalid = [];
for (const c of classes) {
	for (const m of c.members) {
		const code = codeFor(c.name, m.name);
		if (m.isMethod) {
			invalid.push(`{ code: ${s(code)}, errors: [{ messageId: 'methodDestructure', data: { name: ${s(m.name)} } }] },`);
		} else {
			valid.push(`${s(code)},`);
		}
	}
}

const content = readFileSync(testPath, 'utf8');
if (!content.includes('// __GEN_VALID__') || !content.includes('// __GEN_INVALID__')) {
	throw new Error('markers // __GEN_VALID__ / // __GEN_INVALID__ not found in test file');
}
const out = content
	.replace('// __GEN_VALID__', valid.join('\n\t\t'))
	.replace('// __GEN_INVALID__', invalid.join('\n\t\t'));
writeFileSync(testPath, out);

console.log(`generated ${invalid.length} invalid (method) + ${valid.length} valid (getter/property) rule-tester cases`);
