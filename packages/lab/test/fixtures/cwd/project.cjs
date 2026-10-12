const { readFileSync } = require('node:fs');
const { defineProject, defineScenario } = require('../../../lib/index.js');

let name;
try {
	name = readFileSync('cwd-marker.txt', 'utf8').trim();
} catch {
	throw new Error('No seyfert.config file found.');
}

const project = defineProject({
	name,
	scenarios: [defineScenario({ id: 'cwd', version: 1, title: 'Cwd' })],
	bot: () => ({}),
});
module.exports = { project };
