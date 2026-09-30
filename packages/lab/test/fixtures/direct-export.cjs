const { defineProject, defineScenario } = require('../../lib/index.js');

module.exports = defineProject({
	name: 'direct-export',
	scenarios: [defineScenario({ id: 'shape', version: 1, title: 'Shape' })],
	bot: () => ({}),
	inspect: { shape: () => 'module.exports' },
});
