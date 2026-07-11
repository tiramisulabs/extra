import { describe, expect, test } from 'vitest';
import * as api from '../src';

// Guardrail: the public barrel (src/index.ts + the curated bot/index.ts allowlist) is maintained by discipline.
// Snapshot the export names so an accidental `export *` of an internal — or a removed public symbol — shows up as
// a reviewable diff instead of silently changing the package's API surface. Update with `vitest -u` on purpose.
describe('public API surface', () => {
	test('exported names match the committed snapshot', () => {
		expect(Object.keys(api).sort()).toMatchSnapshot();
	});
});
