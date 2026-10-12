import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createChildSession, describeChildProject } from '../src/child';

const fixture = resolve(process.cwd(), 'test/fixtures/hosted.cjs');

test('describe and sessions use the same explicit child environment', async () => {
	const dir = await mkdtemp(resolve(tmpdir(), 'lab-child-env-'));
	const marker = resolve(dir, 'loads.txt');
	const hidden = process.env.LAB_HIDDEN;
	const forwarded = process.env.LAB_FORWARDED;
	process.env.LAB_HIDDEN = 'hidden-value';
	process.env.LAB_FORWARDED = 'forwarded-value';
	try {
		const options = {
			projectModule: fixture,
			inheritEnv: false,
			childEnv: ['LAB_FORWARDED'],
			env: { LAB_DESCRIBE_MARKER: marker },
		};
		expect((await describeChildProject(options)).name).toBe('hosted-fixture');
		const first = JSON.parse((await readFile(marker, 'utf8')).trim()) as {
			hidden: string | null;
			forwarded: string | null;
		};
		expect(first).toEqual({ hidden: null, forwarded: 'forwarded-value' });
		const session = createChildSession({ ...options, preset: { scenario: { id: 'hosted', version: 1 } } });
		await session.start();
		try {
			expect(await session.inspectProject('environment')).toEqual({ hidden: null, forwarded: 'forwarded-value' });
		} finally {
			await session.dispose();
		}
	} finally {
		if (hidden === undefined) delete process.env.LAB_HIDDEN;
		else process.env.LAB_HIDDEN = hidden;
		if (forwarded === undefined) delete process.env.LAB_FORWARDED;
		else process.env.LAB_FORWARDED = forwarded;
		await rm(dir, { recursive: true, force: true });
	}
});
