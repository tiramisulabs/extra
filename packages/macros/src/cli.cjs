#!/usr/bin/env node
const command = process.argv[2];
if (command === 'setup') {
	require('./setup.cjs').setup(process.argv.slice(3));
} else if (command === 'build') {
	process.argv.splice(2, 1);
	require('./build.cjs');
} else {
	console.log('Usage: slipher-macros setup [-p tsconfig.json]\n       slipher-macros build [TypeScript options]');
	if (command && command !== '--help' && command !== '-h') process.exitCode = 1;
}
