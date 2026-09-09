function resolveProject(project) {
	const resolved = path.resolve(project);
	if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return path.join(resolved, 'tsconfig.json');
	return resolved;
}

function projectFromBuild(build) {
	const firstCommand = build?.split(/&&|\|\||;/)[0];
	if (!/^(?:tsc|slipher-macros build)(?:\s|$)/.test(firstCommand ?? '')) return undefined;
	const project = /(?:^|\s)(?:-p|--project)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(firstCommand);
	return project && (project[1] ?? project[2] ?? project[3]);
}

function updateBuildScript(build, configPath, hasProject) {
	const relative = path.relative(process.cwd(), configPath);
	const command =
		relative === 'tsconfig.json' ? 'slipher-macros build' : `slipher-macros build -p ${JSON.stringify(relative)}`;
	if (!build) return command;
	if (/^slipher-macros build(?:\s|$)/.test(build)) {
		return hasProject ? build : build.replace(/^slipher-macros build/, command);
	}
	if (!/^tsc(?:\s|$)/.test(build) || /(?:^|\s)(?:--watch|-w|--build|-b)(?:\s|$)/.test(build)) {
		throw new Error(
			'The existing build is not a plain tsc build. Configure slipher-macros build in that toolchain before running setup. No files changed.',
		);
	}
	return build.replace(/^tsc/, hasProject ? 'slipher-macros build' : command);
}

function readProject(configPath) {
	const text = fs.readFileSync(configPath, 'utf8');
	const config = ts.parseConfigFileTextToJson(configPath, text);
	if (config.error) throw new Error(`Invalid tsconfig: ${configPath}`);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
	// An empty source directory is valid during setup.
	if (parsed.errors.some(error => error.code !== 18003)) throw new Error(`Invalid tsconfig: ${configPath}`);
	return { text, plugins: parsed.options.plugins ?? [] };
}

function setup(args) {
	const options = ts.parseCommandLine(args);
	const invalidArguments =
		options.errors.length || options.fileNames.length || Object.keys(options.options).some(key => key !== 'project');
	if (invalidArguments) throw new Error('Usage: slipher-macros setup [-p tsconfig.json]');

	const packagePath = path.resolve('package.json');
	const packageText = fs.readFileSync(packagePath, 'utf8');
	const manifest = JSON.parse(packageText);
	const build = manifest.scripts?.build;
	const buildProject = projectFromBuild(build);
	const configPath = resolveProject(options.options.project ?? buildProject ?? 'tsconfig.json');
	if (buildProject && resolveProject(buildProject) !== configPath) {
		throw new Error('The requested project differs from the build project. No files changed.');
	}

	const config = readProject(configPath);
	const plugin = '@slipher/macros/plugin';
	const nextBuild = updateBuildScript(build, configPath, Boolean(buildProject));
	const nextConfig = config.plugins.some(item => item.name === plugin)
		? config.text
		: updateProperty(config.text, configPath, ['compilerOptions', 'plugins'], [...config.plugins, { name: plugin }]);
	const nextPackage =
		nextBuild === build ? packageText : updateProperty(packageText, packagePath, ['scripts', 'build'], nextBuild);

	// Validate both edits before changing either file.
	JSON.parse(nextPackage);
	if (ts.parseJsonText(configPath, nextConfig).parseDiagnostics.length)
		throw new Error('Could not update tsconfig safely');
	if (nextConfig !== config.text) fs.writeFileSync(configPath, nextConfig);
	if (nextPackage !== packageText) fs.writeFileSync(packagePath, nextPackage);
	console.log(
		'Configured the build and TypeScript editor plugin. In VS Code, select the workspace TypeScript version and restart the TS server.',
	);
}

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { updateProperty } = require('./jsonc.cjs');
module.exports = { setup };
