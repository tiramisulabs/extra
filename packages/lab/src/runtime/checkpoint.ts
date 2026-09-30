import type { Checkpoint } from '../index';
import { validateCheckpoint } from '../protocol';

export { createCheckpoint } from '../protocol';

export function exportTest(
	checkpoint: Checkpoint,
	options: { format: 'vitest' | 'node'; projectModule?: string },
): string {
	validateCheckpoint(checkpoint);
	const projectModule = options.projectModule ?? checkpoint.projectModule;
	if (!projectModule) throw new Error('Export requires a project module path');
	if (options.format !== 'vitest' && options.format !== 'node')
		throw new Error(`Unknown export format: ${options.format}`);
	const testImport = options.format === 'vitest' ? 'vitest' : 'node:test';
	const assertion = checkpoint.arrival.length
		? 'await replay(project, checkpoint);'
		: "throw new Error('Checkpoint has no explicit expectations; pin an arrival condition or action result before using this test.');";
	return `import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from '${testImport}';
import { replay } from '@slipher/lab/runtime';
import type { Checkpoint, Project } from '@slipher/lab';

const require = createRequire(import.meta.url);
const modulePath = ${JSON.stringify(projectModule)};
let loaded: Partial<Project> & { project?: Project; default?: Project };
try {
  loaded = require(modulePath) as typeof loaded;
} catch (error) {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_REQUIRE_ESM') throw error;
  loaded = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath) as typeof loaded;
}
const project = loaded.project ?? loaded.default ?? (loaded.scenarios ? loaded as Project : undefined);
if (!project) throw new Error('Project module has no project export');
const checkpoint: Checkpoint = ${JSON.stringify(checkpoint, null, 2)};

test(${JSON.stringify(checkpoint.name)}, async () => {
  ${assertion}
});
`;
}
