const { appendFileSync } = require('node:fs');
const { defineProject, defineScenario } = require('../../lib/index.js');

if (process.env.LAB_DESCRIBE_MARKER)
	appendFileSync(
		process.env.LAB_DESCRIBE_MARKER,
		`${JSON.stringify({ hidden: process.env.LAB_HIDDEN ?? null, forwarded: process.env.LAB_FORWARDED ?? null })}\n`,
	);

const project = defineProject({
	name: 'hosted-fixture',
	scenarios: [defineScenario({ id: 'hosted', version: 1, title: 'Hosted' })],
	bot: () => ({}),
	inspect: {
		environment: () => ({ hidden: process.env.LAB_HIDDEN ?? null, forwarded: process.env.LAB_FORWARDED ?? null }),
		identity: () => ({ pid: process.pid }),
	},
});
module.exports = { project };
