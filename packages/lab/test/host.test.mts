import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { type LabHost, startHost } from '../src/host';
import { PROTOCOL_VERSION } from '../src/protocol';
import { createCheckpoint } from '../src/runtime';

const fixture = resolve(process.cwd(), 'test/fixtures/project.cjs');
const life = resolve(process.cwd(), 'test/fixtures/lifecycle.cjs');
const description = resolve(process.cwd(), 'test/fixtures/description.cjs');
const cwdDir = resolve(process.cwd(), 'test/fixtures/cwd');
const cwdFixture = resolve(cwdDir, 'project.cjs');
const hosts: LabHost[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
	try {
		for (const host of hosts.splice(0)) await host.close();
	} finally {
		for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true });
	}
});
async function tempDataDir(): Promise<string> {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'slipher-lab-host-'));
	dataDirs.push(dataDir);
	return dataDir;
}
async function post(url: string, path: string, value: unknown): Promise<Response> {
	return fetch(`${url}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(value),
	});
}
async function rpc(
	url: string,
	id: number,
	type: string,
	payload?: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
	const response = await post(url, '/api/rpc', {
		version: PROTOCOL_VERSION,
		id,
		type,
		...(payload === undefined ? {} : { payload }),
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<{ ok: boolean; value?: unknown; error?: string }>;
}

test('describe uses metadata without starting a session', async () => {
	const host = await startHost({ projectModule: description });
	hosts.push(host);
	const response = await fetch(`${host.url}/api/describe`);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		name: 'description',
		scenarios: [
			{
				id: 'one',
				version: 2,
				title: 'First flow',
				params: {
					active: { kind: 'boolean', default: true, label: 'Active' },
					label: { kind: 'string', default: 'Hello' },
					count: { kind: 'number', default: 2 },
					mode: { kind: 'enum', default: 'ok', values: ['ok', 'fail'] },
				},
			},
		],
		services: { api: { default: 'ok', variants: ['ok', 'fail'] } },
		inspectors: ['identity'],
	});
	expect((await fetch(host.url)).status).toBe(200);
});

test('explicit cwd applies to describe, session start and replay', async () => {
	const missingConfig = 'No seyfert.config file found. Run the CLI from the bot directory or pass --cwd <dir>.';
	const preset = { scenario: { id: 'cwd', version: 1 } };
	const wrong = await startHost({ projectModule: cwdFixture });
	hosts.push(wrong);
	const failedDescribe = await fetch(`${wrong.url}/api/describe`);
	expect(failedDescribe.status).toBe(500);
	expect(await failedDescribe.json()).toEqual({ error: missingConfig });
	const failedStart = await post(wrong.url, '/api/session', { preset });
	expect(failedStart.status).toBe(500);
	expect(await failedStart.json()).toMatchObject({ error: expect.stringContaining(missingConfig) });

	const host = await startHost({ projectModule: cwdFixture, cwd: cwdDir, dataDir: await tempDataDir() });
	hosts.push(host);
	expect(await fetch(`${host.url}/api/describe`).then(response => response.json())).toMatchObject({
		name: 'cwd-fixture',
	});
	expect((await post(host.url, '/api/session', { preset })).status).toBe(201);
	const log = (await rpc(host.url, 1, 'session.log')).value as Parameters<typeof createCheckpoint>[0];
	const checkpoint = createCheckpoint(log, 'cwd_replay', []);
	expect((await post(host.url, '/api/checkpoints', { checkpoint })).status).toBe(201);
	expect((await post(host.url, '/api/checkpoints/cwd_replay/replay', {})).status).toBe(200);
});

test('CLI parses --cwd and dash-prefixed --node-arg values for the child', async () => {
	const args = ['--project', cwdFixture, '--cwd', cwdDir, '--node-arg', '--no-warnings'];
	const cli = spawn(process.execPath, ['lib/host/cli.js', ...args], {
		cwd: process.cwd(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	cli.stderr.on('data', chunk => {
		stderr += String(chunk);
	});
	try {
		const url = await new Promise<string>((done, reject) => {
			const timer = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 5000);
			cli.once('exit', code => {
				clearTimeout(timer);
				reject(new Error(`CLI exited ${code}: ${stderr}`));
			});
			cli.stdout.once('data', chunk => {
				clearTimeout(timer);
				done(String(chunk).trim());
			});
		});
		expect((await post(url, '/api/session', { preset: { scenario: { id: 'cwd', version: 1 } } })).status).toBe(201);
	} finally {
		if (cli.exitCode === null && cli.signalCode === null) {
			cli.kill('SIGTERM');
			await new Promise(done => cli.once('exit', done));
		}
	}
});

test('start, act, SSE reconnect, view and inspect over RPC', async () => {
	const host = await startHost({ projectModule: fixture });
	hosts.push(host);
	const stream = await fetch(`${host.url}/api/events`);
	const reader = stream.body?.getReader();
	expect(stream.status).toBe(200);
	const started = await post(host.url, '/api/session', { preset: { scenario: { id: 'flow', version: 1 } } });
	expect(started.status).toBe(201);
	expect(await started.json()).toEqual({ ok: true });
	const result = await rpc(host.url, 7, 'session.act', {
		kind: 'user',
		actor: 'alice',
		verb: 'slash',
		command: 'flow',
	});
	expect(result).toMatchObject({ ok: true, id: 7 });
	const view = await rpc(host.url, 8, 'session.view', { actor: 'alice', channelRef: 'channel' });
	expect(
		(view.value as { messages: { payload: { content: string } }[] }).messages.some(
			item => item.payload.content === 'Panel',
		),
	).toBe(true);
	const inspect = await rpc(host.url, 9, 'session.inspect');
	expect(inspect.value).toMatchObject({ world: expect.any(Object), pending: expect.any(Object) });
	const first = await reader?.read();
	const text = new TextDecoder().decode(first?.value);
	expect(text).toContain('event: session-started');
	const reconnect = await fetch(`${host.url}/api/events`, { headers: { 'Last-Event-ID': '0' } });
	const replayReader = reconnect.body?.getReader();
	const replay = new TextDecoder().decode((await replayReader?.read())?.value);
	expect(replay).toContain('event: session-started');
	await reader?.cancel();
	await replayReader?.cancel();
});

test('rejects nonlocal Host, bad JSON and invalid actions', async () => {
	const host = await startHost({ projectModule: fixture });
	hosts.push(host);
	const foreign = await new Promise<number>((done, reject) => {
		const req = request(`${host.url}/api/describe`, { headers: { Host: 'evil.example:1234' } }, res => {
			res.resume();
			done(res.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
	expect(foreign).toBe(403);
	expect((await fetch(`${host.url}/api/describe`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
	const badJson = await fetch(`${host.url}/api/session`, { method: 'POST', body: '{' });
	expect(badJson.status).toBe(400);
	expect(await badJson.json()).toEqual({ error: 'Invalid JSON body' });
	const invalid = await post(host.url, '/api/rpc', {
		version: PROTOCOL_VERSION,
		id: 3,
		type: 'session.act',
		payload: { kind: 'strange' },
	});
	expect(invalid.status).toBe(400);
	expect(((await invalid.json()) as { error: string }).error).toContain('action.kind');
	const tooLarge = await fetch(`${host.url}/api/session`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
	expect(tooLarge.status).toBe(413);
});

test('rejects non-loopback bind before listen', async () => {
	for (const hostname of ['0.0.0.0', '192.0.2.1', 'example.com'])
		await expect(startHost({ projectModule: fixture, hostname })).rejects.toThrow('Host must bind');
	const cli = spawnSync(process.execPath, ['lib/host/cli.js', '--project', fixture, '--host', '0.0.0.0'], {
		cwd: process.cwd(),
		encoding: 'utf8',
	});
	expect(cli.status).toBe(1);
	expect(cli.stderr).toContain('Host must bind');
});

test('serves UI assets and SPA fallback without escaping uiDir', async () => {
	const host = await startHost({ projectModule: fixture, uiDir: resolve(process.cwd(), 'test/fixtures/ui') });
	hosts.push(host);
	const page = await fetch(`${host.url}/scenario/one`);
	expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
	expect(await page.text()).toContain('Lab fixture');
	const css = await fetch(`${host.url}/app.css`);
	expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
	expect(await css.text()).toContain('color: black');
	expect((await fetch(`${host.url}/%2e%2e%2fproject.cjs`)).status).toBe(403);
});

test('session replacement stops after failed cleanup', async () => {
	const host = await startHost({ projectModule: life, env: { LAB_CLEANUP_FAIL: '1' } });
	hosts.push(host);
	const preset = { scenario: { id: 'life', version: 1 } };
	expect((await post(host.url, '/api/session', { preset })).status).toBe(201);
	const identity = await rpc(host.url, 1, 'session.inspectProject', { name: 'identity' });
	const pid = (identity.value as { pid: number }).pid;
	const replacement = await post(host.url, '/api/session', { preset });
	expect(replacement.status).toBe(500);
	expect(((await replacement.json()) as { error: string }).error).toContain('external cleanup may be pending');
	expect((await post(host.url, '/api/rpc', { version: PROTOCOL_VERSION, id: 2, type: 'session.inspect' })).status).toBe(
		409,
	);
	expect(() => process.kill(pid, 0)).toThrow();
});

test('replay stops the visual session and aborts when cleanup fails', async () => {
	const dataDir = await tempDataDir();
	const host = await startHost({ projectModule: life, dataDir, env: { LAB_CLEANUP_FAIL: '1' } });
	hosts.push(host);
	const preset = { scenario: { id: 'life', version: 1 } };
	expect((await post(host.url, '/api/session', { preset })).status).toBe(201);
	const log = (await rpc(host.url, 1, 'session.log')).value as Parameters<typeof createCheckpoint>[0];
	const checkpoint = createCheckpoint(log, 'cleanup_failure', [{ path: 'world.guilds', equals: [] }]);
	expect((await post(host.url, '/api/checkpoints', { checkpoint })).status).toBe(201);
	const replay = await post(host.url, '/api/checkpoints/cleanup_failure/replay', {});
	expect(replay.status).toBe(500);
	expect(((await replay.json()) as { error: string }).error).toContain('external cleanup may be pending');
	expect((await post(host.url, '/api/rpc', { version: PROTOCOL_VERSION, id: 2, type: 'session.inspect' })).status).toBe(
		409,
	);
});

test('close terminates the active child', async () => {
	const host = await startHost({ projectModule: life });
	hosts.push(host);
	expect((await post(host.url, '/api/session', { preset: { scenario: { id: 'life', version: 1 } } })).status).toBe(201);
	const identity = await rpc(host.url, 1, 'session.inspectProject', { name: 'identity' });
	const pid = (identity.value as { pid: number }).pid;
	await host.close();
	expect(() => process.kill(pid, 0)).toThrow();
});

test('timed out inspector releases the host queue', async () => {
	const host = await startHost({ projectModule: life, rpcTimeoutMs: 80, disposeTimeoutMs: 100 });
	hosts.push(host);
	expect((await post(host.url, '/api/session', { preset: { scenario: { id: 'life', version: 1 } } })).status).toBe(201);
	const hung = rpc(host.url, 1, 'session.inspectProject', { name: 'hang' });
	const queued = post(host.url, '/api/rpc', { version: PROTOCOL_VERSION, id: 2, type: 'session.inspect' });
	expect(await hung).toMatchObject({ ok: false, error: expect.stringContaining('timed out after 80ms') });
	expect((await queued).status).toBe(409);
	expect((await fetch(`${host.url}/api/session`, { method: 'DELETE' })).status).toBe(200);
});

test('compiled root and protocol do not load process, HTTP or Seyfert modules', () => {
	const script = `const Module = require('node:module'); const load = Module._load; const seen = []; Module._load = function (name, ...rest) { if (name === 'node:child_process' || name === 'node:http' || name === 'seyfert') seen.push(name); return load.call(this, name, ...rest); }; require('./lib/index.js'); require('./lib/protocol/index.js'); process.stdout.write(JSON.stringify(seen));`;
	expect(execFileSync(process.execPath, ['-e', script], { cwd: process.cwd(), encoding: 'utf8' })).toBe('[]');
});

test('checkpoint HTTP save, load, replay, export and strict load errors', async () => {
	const dataDir = await tempDataDir();
	const host = await startHost({ projectModule: fixture, dataDir });
	hosts.push(host);
	expect(await fetch(`${host.url}/api/checkpoints`).then(response => response.json())).toEqual({ names: [] });
	expect((await post(host.url, '/api/session', { preset: { scenario: { id: 'flow', version: 1 } } })).status).toBe(201);
	await rpc(host.url, 1, 'session.act', {
		kind: 'user',
		actor: 'alice',
		verb: 'slash',
		command: 'support',
		subcommand: 'open',
	});
	const log = (await rpc(host.url, 2, 'session.log')).value as Parameters<typeof createCheckpoint>[0];
	const checkpoint = createCheckpoint(log, 'http_flow', [
		{ view: { actor: 'alice', channel: 'channel' }, contains: 'support opened' },
	]);
	expect((await post(host.url, '/api/checkpoints', { checkpoint })).status).toBe(201);
	expect(await fetch(`${host.url}/api/checkpoints`).then(response => response.json())).toEqual({
		names: ['http_flow'],
	});
	expect(await fetch(`${host.url}/api/checkpoints/http_flow`).then(response => response.json())).toMatchObject({
		name: 'http_flow',
		version: 1,
	});
	const events = await fetch(`${host.url}/api/events`);
	const reader = events.body?.getReader();
	expect((await post(host.url, '/api/checkpoints/http_flow/replay', {})).status).toBe(200);
	let replayEvents = '';
	while (!replayEvents.includes('event: session-stopped'))
		replayEvents += new TextDecoder().decode((await reader?.read())?.value);
	expect(replayEvents).toContain('"reason":"replay"');
	await reader?.cancel();
	expect((await post(host.url, '/api/rpc', { version: PROTOCOL_VERSION, id: 3, type: 'session.inspect' })).status).toBe(
		409,
	);
	const exported = (await fetch(`${host.url}/api/checkpoints/http_flow/export?format=vitest`).then(response =>
		response.json(),
	)) as { code: string };
	expect(exported.code).toContain("import { replay } from '@slipher/lab/runtime'");
	expect((await post(host.url, '/api/checkpoints', { checkpoint: { ...checkpoint, version: 2 } })).status).toBe(400);
	expect((await post(host.url, '/api/checkpoints', { checkpoint: { ...checkpoint, name: '../escape' } })).status).toBe(
		400,
	);
	expect((await fetch(`${host.url}/api/checkpoints/%2e%2e%2fescape`)).status).toBe(400);
	expect((await fetch(`${host.url}/api/checkpoints/missing`)).status).toBe(404);
	await writeFile(resolve(dataDir, 'bad.json'), JSON.stringify({ ...checkpoint, version: 9 }));
	expect((await fetch(`${host.url}/api/checkpoints/bad`)).status).toBe(400);
	expect(await readFile(resolve(dataDir, 'http_flow.json'), 'utf8')).toContain('"protocolVersion": 1');
	const outside = resolve(dataDir, 'outside');
	await writeFile(outside, 'untouched');
	await symlink(outside, resolve(dataDir, 'linked.json'));
	expect((await post(host.url, '/api/checkpoints', { checkpoint: { ...checkpoint, name: 'linked' } })).status).toBe(
		400,
	);
	expect((await fetch(`${host.url}/api/checkpoints/linked`)).status).toBe(400);
	expect(await readFile(outside, 'utf8')).toBe('untouched');
});
