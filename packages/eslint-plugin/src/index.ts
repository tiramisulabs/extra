import type { Linter } from 'eslint';
import plugin from './rules/_';

/**
 * Ready-made flat-config block. Type-aware rules require the consumer to wire
 * the typescript-eslint parser with type information (`projectService: true`),
 * e.g. via `tseslint.configs.recommendedTypeChecked`.
 */
export const configs: { recommended: Linter.Config[] } = {
	recommended: [
		{
			plugins: { seyfert: plugin },
			rules: {
				'seyfert/require-declare': 'error',
				'seyfert/no-deep-imports': 'error',
				'seyfert/options-use-builders': 'error',
				'seyfert/no-hanging-middleware': 'error',
				'seyfert/decorator-target': 'error',
			},
		},
	],
};

export { plugin };
export default plugin;
