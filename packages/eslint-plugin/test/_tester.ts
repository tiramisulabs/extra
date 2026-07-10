import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

// Wire @typescript-eslint/rule-tester to the vitest runner.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/**
 * A RuleTester with full type information. Inline test cases are type-checked
 * against the real `seyfert` types resolved from `node_modules`, so the
 * type-aware rules behave exactly as they would in a consumer project.
 */
export function createTester(): RuleTester {
	return new RuleTester({
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['*.ts*'],
					defaultProject: 'tsconfig.json',
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	});
}
