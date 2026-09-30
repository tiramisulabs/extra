import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import type { SessionEvent } from '../src';
import { createChildSession, describeChildProject } from '../src/child';

const shapes = [
	{ file: 'direct-export.cjs', name: 'direct-export', shape: 'module.exports' },
	{ file: 'default-export.mjs', name: 'default-export', shape: 'export default' },
];

test.each(shapes)('worker loads a project from $shape', async ({ file, name, shape }) => {
	const projectModule = resolve(process.cwd(), 'test/fixtures', file);
	expect((await describeChildProject({ projectModule })).name).toBe(name);
	const session = createChildSession({ projectModule, preset: { scenario: { id: 'shape', version: 1 } } });
	await session.start();
	try {
		expect(await session.inspectProject('shape')).toBe(shape);
	} finally {
		await session.dispose();
	}
});

test('a throwing observer of a child session is reported to the other observers', async () => {
	const session = createChildSession({
		projectModule: resolve(process.cwd(), 'test/fixtures/hosted.cjs'),
		preset: { scenario: { id: 'hosted', version: 1 } },
	});
	const seen: SessionEvent[] = [];
	session.observe(event => {
		if (event.type === 'started') throw new Error('observer broke');
	});
	session.observe(event => {
		seen.push(event);
	});
	await session.start();
	try {
		expect(seen).toContainEqual({ type: 'error', origin: 'observer', detail: 'Observer failed: observer broke' });
		expect(seen.map(event => event.type)).toContain('started');
		expect((await session.inspect()).diagnostics).toContain('Observer failed: observer broke');
	} finally {
		await session.dispose();
	}
});
