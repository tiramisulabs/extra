import lab from '../../lib/index.js';

export default lab.defineProject({
	name: 'default-export',
	scenarios: [lab.defineScenario({ id: 'shape', version: 1, title: 'Shape' })],
	bot: () => ({}),
	inspect: { shape: () => 'export default' },
});
