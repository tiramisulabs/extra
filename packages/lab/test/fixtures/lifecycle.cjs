const { defineProject, defineScenario } = require('../../lib/index.js');
const { existsSync, writeFileSync } = require('node:fs');
const moduleCount = (globalThis.__labModuleCount = (globalThis.__labModuleCount ?? 0) + 1);
if (process.env.LAB_HOLD_OPEN === '1') setInterval(() => {}, 1000);
let setups = 0;
let setupFinished = false;
const project = defineProject({
	name: 'lifecycle',
	scenarios: [defineScenario({ id: 'life', version: 1, title: 'Life' })],
	resources: {
		setup: async () => {
			setups++;
			if (process.env.LAB_SETUP_STARTED_MARKER)
				writeFileSync(process.env.LAB_SETUP_STARTED_MARKER, String(process.pid));
			if (process.env.LAB_SETUP_GATE)
				while (!existsSync(process.env.LAB_SETUP_GATE)) await new Promise(done => setTimeout(done, 10));
			if (process.env.LAB_SLOW_SETUP_MS)
				await new Promise(done => setTimeout(done, Number(process.env.LAB_SLOW_SETUP_MS)));
			setupFinished = true;
			if (process.env.LAB_SETUP_FINISHED_MARKER) writeFileSync(process.env.LAB_SETUP_FINISHED_MARKER, 'finished');
			return {};
		},
		dispose: async () => {
			if (process.env.LAB_SLOW_DISPOSE_MS)
				await new Promise(done => setTimeout(done, Number(process.env.LAB_SLOW_DISPOSE_MS)));
			if (process.env.LAB_DISPOSE_MARKER)
				writeFileSync(
					process.env.LAB_DISPOSE_MARKER,
					process.env.LAB_SETUP_GATE ? (setupFinished ? 'disposed after setup' : 'disposed before setup') : 'disposed',
				);
			if (process.env.LAB_CLEANUP_FAIL === '1') throw new Error('cleanup failed; external cleanup may be pending');
		},
	},
	bot: () => ({}),
	inspect: {
		identity: () => ({ pid: process.pid, moduleCount, setups }),
		hang: () => new Promise(() => {}),
	},
});
module.exports = { project };
