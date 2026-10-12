const { defineProject, defineScenario, param } = require('../../lib/index.js');
const project = defineProject({
	name: 'description',
	scenarios: [
		defineScenario({
			id: 'one',
			version: 2,
			title: 'First flow',
			params: {
				active: param.boolean({ default: true, label: 'Active' }),
				label: param.string({ default: 'Hello' }),
				count: param.number({ default: 2 }),
				mode: param.enum({ default: 'ok', values: ['ok', 'fail'] }),
			},
		}),
	],
	configure: () => {
		throw new Error('configure must not run during describe');
	},
	services: { api: { default: 'ok', variants: { ok: () => {}, fail: () => {} } } },
	inspect: { identity: () => null },
});
module.exports = { project };
