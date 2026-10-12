import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { SessionLog } from '../src';
import { type LabHost, startHost } from '../src/host';
import { validateHostInfo } from '../src/protocol';
import { createCheckpoint } from '../src/runtime';
import { closeHosts, hostedRequest, tempDataDir } from './helpers.mjs';

const hosts: LabHost[] = [];
afterEach(() => closeHosts(hosts));
const revision = 'a'.repeat(40);
const projectModule = resolve(process.cwd(), 'test/fixtures/project.cjs');
const fence = (preset: unknown) => `\`\`\`json slipher-lab\n${JSON.stringify(preset)}\n\`\`\``;
const preset = {
	scenario: { id: 'flow', version: 1 },
	params: { label: 'PR data' },
	refs: { guild: '123456789012345678' },
};

async function post(url: string, path: string, body: unknown) {
	return fetch(`${url}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

test('a PR recipe configures the bot, survives source edits and exports with its recorded data', async () => {
	const source = {
		headRefOid: revision,
		body: `Example only:\n\`\`\`\`markdown\n${fence({})}\n\`\`\`\`\n<details>\n<summary>Scenario Requirements</summary>\n\n${fence(preset)}\n</details>`,
	};
	const host = await startHost({
		projectModule,
		pullRequest: source,
		build: { revision },
		dataDir: await tempDataDir(),
	});
	hosts.push(host);
	source.body = fence({ ...preset, params: { label: 'Edited later' } });
	const info = await fetch(`${host.url}/api/host`).then(r => r.json());
	validateHostInfo(info);
	expect(info.preset).toEqual(preset);
	for (let round = 0; round < 2; round++) {
		expect((await post(host.url, '/api/session', {})).status).toBe(201);
		const response = await post(host.url, '/api/rpc', {
			version: 1,
			id: 1,
			type: 'session.inspectProject',
			payload: { name: 'fixture' },
		});
		expect(await response.json()).toMatchObject({ ok: true, value: { label: 'PR data' } });
	}
	const log = (await post(host.url, '/api/rpc', { version: 1, id: 2, type: 'session.log' }).then(r => r.json())) as {
		value: SessionLog;
	};
	const checkpoint = createCheckpoint(log.value, 'pr-data', [
		{ project: { name: 'fixture', path: 'label' }, equals: 'PR data' },
	]);
	expect((await post(host.url, '/api/checkpoints', { checkpoint })).status).toBe(201);
	expect((await post(host.url, '/api/checkpoints/pr-data/replay', {})).status).toBe(200);
	const exported = (await fetch(`${host.url}/api/checkpoints/pr-data/export?format=node`).then(r => r.json())) as {
		code: string;
	};
	const testFile = resolve(await tempDataDir(), 'regression.mts');
	await symlink(resolve(process.cwd(), '../lab-ui/node_modules'), resolve(testFile, '..', 'node_modules'), 'dir');
	await writeFile(testFile, exported.code);
	const result = spawnSync(process.execPath, [testFile], { encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
});

test.each([
	['wrong commit', fence(preset), 'b'.repeat(40), 'does not match'],
	['ambiguous recipe', `${fence(preset)}\n${fence(preset)}`, revision, 'at most one'],
	['invalid JSON', '\`\`\`json slipher-lab\n{\n\`\`\`', revision, 'JSON'],
	['unclosed fence', '\`\`\`json slipher-lab\n{}', revision, 'Unclosed'],
	['unknown field', fence({ ...preset, parameter: {} }), revision, 'Unknown PR preset field'],
	['wrong parameter', fence({ ...preset, params: { label: false } }), revision, 'preset parameter'],
])('rejects %s before the preview listens', async (_name, body, headRefOid, error) => {
	await expect(startHost({ projectModule, build: { revision }, pullRequest: { body, headRefOid } })).rejects.toThrow(
		error,
	);
});

test('CLI starts the captured PR with a browser challenge and lossless deployment credentials', async () => {
	const directory = await tempDataDir();
	const file = resolve(directory, 'pr.json');
	await writeFile(file, JSON.stringify({ headRefOid: revision, body: fence(preset) }));
	const password = 'quotes"$value\\nline\nnext';
	const packet = Buffer.from(
		JSON.stringify({ SLIPHER_LAB_PASSWORD: password, SLIPHER_LAB_PUBLIC_ORIGIN: 'http://localhost:0' }),
	).toString('base64');
	const cli = spawn(
		process.execPath,
		[
			'lib/host/cli.js',
			'--project',
			projectModule,
			'--pr',
			file,
			'--build-revision',
			revision,
			'--access',
			'basic',
			'--data',
			directory,
		],
		{
			cwd: process.cwd(),
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, SLIPHER_LAB_DEPLOY_ENV: packet },
		},
	);
	let stderr = '';
	cli.stderr.on('data', chunk => {
		stderr += String(chunk);
	});
	try {
		const url = await Promise.race([
			once(cli.stdout, 'data', { signal: AbortSignal.timeout(5000) }).then(([chunk]) => String(chunk).trim()),
			once(cli, 'exit').then(([code]) => {
				throw new Error(`CLI exited ${code}: ${stderr}`);
			}),
		]);
		const headers = { host: 'localhost:0' };
		const denied = await hostedRequest({ url } as LabHost, 'http://localhost:0', '/api/host', { headers });
		expect(denied.status).toBe(401);
		expect(denied.headers.get('www-authenticate')).toContain('Basic');
		const authorized = { ...headers, authorization: `Basic ${Buffer.from(`lab:${password}`).toString('base64')}` };
		const info = await hostedRequest({ url } as LabHost, 'http://localhost:0', '/api/host', { headers: authorized });
		expect(info.status).toBe(200);
		expect(await info.json()).toMatchObject({ preset, build: { revision } });
		const started = await hostedRequest({ url } as LabHost, 'http://localhost:0', '/api/session', {
			method: 'POST',
			headers: authorized,
			body: {},
		});
		expect(started.status).toBe(201);
	} finally {
		if (cli.exitCode === null && cli.signalCode === null) {
			const stopped = once(cli, 'exit');
			cli.kill('SIGTERM');
			await stopped;
		}
	}
});
