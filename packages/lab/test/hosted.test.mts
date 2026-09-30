import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { type LabHost, startHost } from '../src/host';
import { PROTOCOL_VERSION, validateHostInfo } from '../src/protocol';
import { createCheckpoint } from '../src/runtime';

const origin = 'https://preview.example.test';
const preset = { scenario: { id: 'hosted', version: 1 } };
const fixture = resolve(process.cwd(), 'test/fixtures/hosted.cjs');
const flow = resolve(process.cwd(), 'test/fixtures/project.cjs');
const life = resolve(process.cwd(), 'test/fixtures/lifecycle.cjs');
const hosts: LabHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.close();
});

function hostedOptions(projectModule = fixture) {
	return {
		projectModule,
		build: { revision: 'abc123', ref: 'main' },
		hosted: { publicOrigin: origin, access: { mode: 'trusted-proxy' as const } },
	};
}

function api(
	host: LabHost,
	path: string,
	options: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
	const method = options.method ?? 'GET';
	const target = new URL(host.url);
	return new Promise<Response>((done, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method,
				headers: {
					Host: new URL(origin).host,
					...(method !== 'GET' && method !== 'HEAD' ? { Origin: origin, 'content-type': 'application/json' } : {}),
					...(options.cookie ? { Cookie: options.cookie } : {}),
					...options.headers,
				},
			},
			response => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(name, item);
					else if (value !== undefined) headers.append(name, value);
				}
				const status = response.statusCode ?? 500;
				const noBody = method === 'HEAD' || status === 204 || status === 304;
				if (noBody) response.resume();
				done(
					new Response(noBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers }),
				);
			},
		);
		req.on('error', reject);
		req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
	});
}

async function start(host: LabHost, scenario = preset, cookie?: string) {
	const response = await api(host, '/api/session', { method: 'POST', cookie, body: { preset: scenario } });
	return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
}

async function rpc(host: LabHost, cookie: string, type: string, payload?: unknown) {
	return api(host, '/api/rpc', {
		method: 'POST',
		cookie,
		body: {
			version: PROTOCOL_VERSION,
			id: 1,
			type,
			...(payload === undefined ? {} : { payload }),
		},
	});
}

async function untilEnded(host: LabHost, cookie: string, reason: string) {
	for (let i = 0; i < 100; i++) {
		const response = await api(host, '/api/host', { cookie });
		const info = (await response.json()) as { run: { state: string; reason?: string } };
		if (info.run.state === 'ended' && info.run.reason === reason) return;
		await new Promise(done => setTimeout(done, 10));
	}
	throw new Error(`Run did not end with ${reason}`);
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
	let text = '';
	while (!text.includes(needle)) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const chunk = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`SSE did not emit ${needle}`)), 5000);
			}),
		]).finally(() => {
			if (timer) clearTimeout(timer);
		});
		if (chunk.done) throw new Error(`SSE closed before ${needle}`);
		text += new TextDecoder().decode(chunk.value);
	}
	return text;
}

function partialPost(host: LabHost, path: string, cookie: string, value: unknown) {
	const payload = JSON.stringify(value);
	const midpoint = Math.floor(payload.length / 2);
	const target = new URL(host.url);
	let finish = () => {};
	const pending = new Promise<{ status: number; body: unknown }>((done, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method: 'POST',
				headers: {
					Host: new URL(origin).host,
					Origin: origin,
					Cookie: cookie,
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
				},
			},
			response => {
				let text = '';
				response.on('data', chunk => {
					text += String(chunk);
				});
				response.on('end', () => done({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown }));
			},
		);
		req.on('error', reject);
		req.write(payload.slice(0, midpoint));
		finish = () => req.end(payload.slice(midpoint));
	});
	return { pending, finish: () => finish() };
}

test('hosted run isolation covers acts, reset, checkpoints and SSE history', async () => {
	const host = await startHost(hostedOptions(flow));
	hosts.push(host);
	const scenario = { scenario: { id: 'flow', version: 1 } };
	const a = await start(host, scenario);
	const b = await start(host, scenario);
	expect(a.response.status).toBe(201);
	expect(b.response.status).toBe(201);
	expect(a.cookie).not.toBe(b.cookie);
	const action = { kind: 'user', actor: 'alice', verb: 'slash', command: 'flow' };
	expect(await (await rpc(host, a.cookie!, 'session.act', action)).json()).toMatchObject({ ok: true });
	const aLog = (await (await rpc(host, a.cookie!, 'session.log')).json()) as {
		value: Parameters<typeof createCheckpoint>[0];
	};
	const bLog = (await (await rpc(host, b.cookie!, 'session.log')).json()) as { value: { entries: unknown[] } };
	expect(aLog.value.entries).toHaveLength(1);
	expect(bLog.value.entries).toHaveLength(0);
	const checkpoint = createCheckpoint(aLog.value, 'only_a');
	expect((await api(host, '/api/checkpoints', { method: 'POST', cookie: a.cookie, body: { checkpoint } })).status).toBe(
		201,
	);
	expect(await (await api(host, '/api/checkpoints', { cookie: b.cookie })).json()).toEqual({ names: [] });
	expect(await (await api(host, '/api/checkpoints', { cookie: a.cookie })).json()).toEqual({ names: ['only_a'] });
	const eventsA = await api(host, '/api/events', { cookie: a.cookie, headers: { 'Last-Event-ID': '0' } });
	const eventsB = await api(host, '/api/events', { cookie: b.cookie, headers: { 'Last-Event-ID': '0' } });
	const aReader = eventsA.body!.getReader();
	const bReader = eventsB.body!.getReader();
	const aChunk = await readUntil(aReader, 'session-event');
	const bChunk = new TextDecoder().decode((await bReader.read()).value);
	expect(aChunk).toContain('session-event');
	expect(bChunk).not.toContain('session-event');
	await aReader.cancel();
	await bReader.cancel();
	expect(await (await rpc(host, b.cookie!, 'session.act', action)).json()).toMatchObject({ ok: true });
	const bActionLog = (await (await rpc(host, b.cookie!, 'session.log')).json()) as {
		value: Parameters<typeof createCheckpoint>[0];
	};
	expect(bActionLog.value.entries).toHaveLength(1);
	expect(
		(
			await api(host, '/api/checkpoints', {
				method: 'POST',
				cookie: b.cookie,
				body: { checkpoint: createCheckpoint(bActionLog.value, 'only_b') },
			})
		).status,
	).toBe(201);
	expect(await (await api(host, '/api/checkpoints', { cookie: b.cookie })).json()).toEqual({ names: ['only_b'] });
	expect((await start(host, scenario, a.cookie)).response.status).toBe(201);
	expect(await (await api(host, '/api/checkpoints', { cookie: a.cookie })).json()).toEqual({ names: ['only_a'] });
	expect(
		((await (await rpc(host, b.cookie!, 'session.log')).json()) as { value: { entries: unknown[] } }).value.entries,
	).toHaveLength(1);
	expect((await start(host, scenario, b.cookie)).response.status).toBe(201);
	expect(await (await api(host, '/api/checkpoints', { cookie: b.cookie })).json()).toEqual({ names: ['only_b'] });
	expect(await (await api(host, '/api/host', { cookie: a.cookie })).json()).toMatchObject({ run: { session: true } });
	const replayEvents = await api(host, '/api/events', { cookie: a.cookie });
	const replayReader = replayEvents.body!.getReader();
	const replay = await api(host, '/api/checkpoints/only_a/replay', { method: 'POST', cookie: a.cookie, body: {} });
	expect(replay.status).toBe(200);
	expect(await readUntil(replayReader, 'session-stopped')).toContain('"reason":"replay"');
	await replayReader.cancel();
	expect(replay.headers.get('set-cookie')).toBeNull();
	expect(await (await api(host, '/api/host', { cookie: a.cookie })).json()).toMatchObject({
		run: { state: 'active', session: false },
	});
	expect(await (await api(host, '/api/host', { cookie: b.cookie })).json()).toMatchObject({
		run: { state: 'active', session: true },
	});
	expect(await (await api(host, '/api/checkpoints', { cookie: a.cookie })).json()).toEqual({ names: ['only_a'] });
});

test('run errors, cap, disposal and host info', async () => {
	const host = await startHost({ ...hostedOptions(), hosted: { ...hostedOptions().hosted, maxRuns: 1 } });
	hosts.push(host);
	const info = await (await api(host, '/api/host')).json();
	validateHostInfo(info);
	expect(info).toMatchObject({ mode: 'hosted', build: { revision: 'abc123' }, run: { state: 'none' } });
	expect((await api(host, '/api/rpc', { method: 'POST', body: {} })).status).toBe(409);
	expect(await (await api(host, '/api/events')).json()).toMatchObject({ code: 'run-missing' });
	expect(await (await api(host, '/api/checkpoints')).json()).toMatchObject({ code: 'run-missing' });
	expect(await (await api(host, '/api/checkpoints/none/replay', { method: 'POST', body: {} })).json()).toMatchObject({
		code: 'run-missing',
	});
	const instanceId = info.instanceId;
	const unknown = await (
		await api(host, '/api/checkpoints', { cookie: `slipher_lab_run=${instanceId}.unknown` })
	).json();
	expect(unknown).toMatchObject({ code: 'run-ended' });
	expect(unknown).not.toHaveProperty('reason');
	expect(await (await api(host, '/api/checkpoints', { cookie: 'slipher_lab_run=other.unknown' })).json()).toMatchObject(
		{ code: 'run-ended', reason: 'restarted' },
	);
	const a = await start(host);
	expect(a.response.status).toBe(201);
	expect(a.response.headers.get('set-cookie')).toContain('Secure');
	expect(await (await api(host, '/api/host', { cookie: a.cookie })).json()).toMatchObject({
		run: { state: 'active', session: true },
	});
	expect(await (await start(host)).response.json()).toMatchObject({ code: 'run-limit' });
	const identity = (await (await rpc(host, a.cookie!, 'session.inspectProject', { name: 'identity' })).json()) as {
		value: { pid: number };
	};
	const stopped = await api(host, '/api/session', { method: 'DELETE', cookie: a.cookie });
	expect(stopped.status).toBe(200);
	expect(stopped.headers.get('set-cookie')).toContain('Max-Age=0');
	expect(() => process.kill(identity.value.pid, 0)).toThrow();
	expect(await (await api(host, '/api/rpc', { method: 'POST', cookie: a.cookie, body: {} })).json()).toMatchObject({
		code: 'run-ended',
		reason: 'stopped',
	});
	expect((await start(host)).response.status).toBe(201);
});

test.each([
	{ idleTtlMs: 60, maxRunMs: 2000, reason: 'expired' },
	{ idleTtlMs: 2000, maxRunMs: 60, reason: 'max-lifetime' },
])('reaper ends runs with $reason', async ({ idleTtlMs, maxRunMs, reason }) => {
	const host = await startHost({ ...hostedOptions(), hosted: { ...hostedOptions().hosted, idleTtlMs, maxRunMs } });
	hosts.push(host);
	const a = await start(host);
	const events = reason === 'expired' ? await api(host, '/api/events', { cookie: a.cookie }) : undefined;
	await untilEnded(host, a.cookie!, reason);
	if (events) {
		const reader = events.body!.getReader();
		const text = await readUntil(reader, 'session-stopped');
		expect(text).toContain(`"reason":"${reason}"`);
		await reader.cancel();
	}
	expect(
		(
			(await api(host, '/api/host', { cookie: a.cookie }).then(response => response.json())) as {
				run: { state: string };
			}
		).run.state,
	).toBe('ended');
});

test('boundary, navigation, health and authorize', async () => {
	const host = await startHost(hostedOptions());
	hosts.push(host);
	expect(
		await (
			await api(host, '/api/health', { headers: { Host: 'foreign.invalid', Origin: 'https://foreign.invalid' } })
		).json(),
	).toEqual({ ok: true });
	for (const site of ['none', 'cross-site']) {
		expect(
			(
				await api(host, '/', {
					headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
				})
			).status,
		).toBe(200);
		expect((await api(host, '/', { method: 'HEAD', headers: { 'Sec-Fetch-Site': site } })).status).toBe(200);
		expect((await api(host, '/api/describe', { headers: { 'Sec-Fetch-Site': site } })).status).toBe(403);
	}
	expect((await api(host, '/api/describe', { headers: { Host: 'foreign.invalid' } })).status).toBe(403);
	expect((await api(host, '/api/describe', { headers: { Origin: 'https://foreign.invalid' } })).status).toBe(403);
	expect((await api(host, '/api/describe', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
	expect(
		(
			await api(host, '/api/session', {
				method: 'POST',
				body: { preset },
				headers: { Origin: 'https://foreign.invalid' },
			})
		).status,
	).toBe(403);
	expect((await api(host, '/api/session', { method: 'POST', body: { preset }, headers: { Origin: '' } })).status).toBe(
		403,
	);
	expect(
		(await api(host, '/api/session', { method: 'POST', body: { preset }, headers: { 'Sec-Fetch-Site': 'cross-site' } }))
			.status,
	).toBe(403);
	expect((await api(host, '/', { headers: { Host: 'foreign.invalid', 'Sec-Fetch-Site': 'none' } })).status).toBe(403);
	const blocked = await startHost({
		...hostedOptions(),
		hosted: { publicOrigin: origin, access: { mode: 'authorize', authorize: () => false } },
	});
	hosts.push(blocked);
	expect((await api(blocked, '/api/describe')).status).toBe(401);
	expect((await fetch(`${blocked.url}/api/health`)).status).toBe(200);
});

test('child environment and cached describe are isolated', async () => {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'lab-hosted-env-'));
	const marker = resolve(dataDir, 'describes.txt');
	process.env.LAB_HIDDEN = 'secret-sentinel';
	process.env.LAB_FORWARDED = 'forward-sentinel';
	try {
		const host = await startHost({
			...hostedOptions(),
			dataDir,
			childEnv: ['LAB_FORWARDED'],
			env: { LAB_DESCRIBE_MARKER: marker },
		});
		hosts.push(host);
		expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
		await api(host, '/api/describe');
		await api(host, '/api/describe');
		expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
		const a = await start(host);
		const result = await (await rpc(host, a.cookie!, 'session.inspectProject', { name: 'environment' })).json();
		expect(result).toMatchObject({ value: { hidden: null, forwarded: 'forward-sentinel' } });
	} finally {
		delete process.env.LAB_HIDDEN;
		delete process.env.LAB_FORWARDED;
		await hosts.pop()?.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('checkpoint revision stamping, mismatch, acceptance and export', async () => {
	const host = await startHost(hostedOptions());
	hosts.push(host);
	const a = await start(host);
	const log = (
		(await (await rpc(host, a.cookie!, 'session.log')).json()) as { value: Parameters<typeof createCheckpoint>[0] }
	).value;
	const checkpoint = createCheckpoint(log, 'revision');
	expect((await api(host, '/api/checkpoints', { method: 'POST', cookie: a.cookie, body: { checkpoint } })).status).toBe(
		201,
	);
	expect(await (await api(host, '/api/checkpoints/revision', { cookie: a.cookie })).json()).toMatchObject({
		build: { revision: 'abc123' },
	});
	const foreign = { ...checkpoint, build: { revision: 'older' } };
	expect(
		await (
			await api(host, '/api/checkpoints', { method: 'POST', cookie: a.cookie, body: { checkpoint: foreign } })
		).json(),
	).toMatchObject({ code: 'revision-mismatch', checkpointRevision: 'older', currentRevision: 'abc123' });
	expect(
		(
			await api(host, '/api/checkpoints', {
				method: 'POST',
				cookie: a.cookie,
				body: { checkpoint: foreign, acceptRevision: true },
			})
		).status,
	).toBe(201);
	expect(await (await api(host, '/api/checkpoints/revision', { cookie: a.cookie })).json()).toMatchObject({
		build: { revision: 'older' },
	});
	expect(
		await (await api(host, '/api/checkpoints/revision/replay', { method: 'POST', cookie: a.cookie, body: {} })).json(),
	).toMatchObject({ code: 'revision-mismatch' });
	expect(
		(
			await api(host, '/api/checkpoints/revision/replay', {
				method: 'POST',
				cookie: a.cookie,
				body: { acceptRevision: true },
			})
		).status,
	).toBe(200);
	const exported = (await (
		await api(host, '/api/checkpoints/revision/export?format=node', { cookie: a.cookie })
	).json()) as { code: string };
	expect(exported.code).toContain('Point this path at the project module');
	expect(exported.code).toContain('"revision": "older"');
	expect(exported.code).toContain('"./lab/project"');
});

test('hosted checkpoint directories are wiped on boot and deleted with the run', async () => {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'lab-hosted-checkpoints-'));
	try {
		const orphan = resolve(dataDir, 'runs', 'orphan', 'old.json');
		await mkdir(resolve(dataDir, 'runs', 'orphan'), { recursive: true });
		await writeFile(orphan, '{}');
		const host = await startHost({ ...hostedOptions(), dataDir });
		hosts.push(host);
		await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
		const a = await start(host);
		const log = (
			(await (await rpc(host, a.cookie!, 'session.log')).json()) as { value: Parameters<typeof createCheckpoint>[0] }
		).value;
		const checkpoint = createCheckpoint(log, 'temporary');
		expect(
			(await api(host, '/api/checkpoints', { method: 'POST', cookie: a.cookie, body: { checkpoint } })).status,
		).toBe(201);
		const id = a.cookie!.split('.')[1];
		const saved = resolve(dataDir, 'runs', id, 'temporary.json');
		expect(await readFile(saved, 'utf8')).toContain('temporary');
		await api(host, '/api/session', { method: 'DELETE', cookie: a.cookie });
		await expect(readFile(saved)).rejects.toMatchObject({ code: 'ENOENT' });
		await host.close();
		hosts.splice(hosts.indexOf(host), 1);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('ending rejects a parsed Start and checkpoint save, and close awaits disposal', async () => {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'lab-hosted-ending-'));
	try {
		const marker = resolve(dataDir, 'disposed');
		const host = await startHost({
			...hostedOptions(life),
			dataDir,
			env: { LAB_SLOW_DISPOSE_MS: '120', LAB_DISPOSE_MARKER: marker },
		});
		hosts.push(host);
		const lifePreset = { scenario: { id: 'life', version: 1 } };
		const a = await start(host, lifePreset);
		const cookie = a.cookie!;
		const log = (
			(await (await rpc(host, cookie, 'session.log')).json()) as { value: Parameters<typeof createCheckpoint>[0] }
		).value;
		const checkpoint = createCheckpoint(log, 'late_write');
		const lateStart = partialPost(host, '/api/session', cookie, { preset: lifePreset });
		const lateSave = partialPost(host, '/api/checkpoints', cookie, { checkpoint });
		await new Promise(done => setTimeout(done, 20));
		const ending = api(host, '/api/session', { method: 'DELETE', cookie });
		await untilEnded(host, cookie, 'stopped');
		lateStart.finish();
		lateSave.finish();
		expect(await lateStart.pending).toMatchObject({ status: 409, body: { code: 'run-ended' } });
		expect(await lateSave.pending).toMatchObject({ status: 409, body: { code: 'run-ended' } });
		await host.close();
		hosts.splice(hosts.indexOf(host), 1);
		expect((await ending).status).toBe(200);
		expect(await readFile(marker, 'utf8')).toBe('disposed');
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});

test('close aggregates disposal errors after ending all runs', async () => {
	const host = await startHost({ ...hostedOptions(life), env: { LAB_CLEANUP_FAIL: '1' } });
	hosts.push(host);
	await start(host, { scenario: { id: 'life', version: 1 } });
	hosts.splice(hosts.indexOf(host), 1);
	await expect(host.close()).rejects.toBeInstanceOf(AggregateError);
});

test('reaper cleanup failures remain visible to close', async () => {
	const host = await startHost({
		...hostedOptions(life),
		env: { LAB_CLEANUP_FAIL: '1' },
		hosted: { ...hostedOptions().hosted, idleTtlMs: 60, maxRunMs: 2000 },
	});
	hosts.push(host);
	const a = await start(host, { scenario: { id: 'life', version: 1 } });
	await untilEnded(host, a.cookie!, 'expired');
	hosts.splice(hosts.indexOf(host), 1);
	await expect(host.close()).rejects.toBeInstanceOf(AggregateError);
});

test('startHost validation, loopback HTTP and local host info', async () => {
	await expect(startHost({ projectModule: fixture, hostname: '0.0.0.0' })).rejects.toThrow('Host must bind');
	await expect(startHost({ ...hostedOptions(), inheritEnv: true })).rejects.toThrow('cannot inherit');
	await expect(
		startHost({
			...hostedOptions(),
			hosted: { ...hostedOptions().hosted, publicOrigin: 'http://preview.example.test' },
		}),
	).rejects.toThrow('HTTP publicOrigin');
	await expect(startHost({ ...hostedOptions(), hosted: { ...hostedOptions().hosted, maxRuns: 0 } })).rejects.toThrow(
		'positive integer',
	);
	const localOrigin = 'http://localhost:4197';
	const loopback = await startHost({
		...hostedOptions(),
		hosted: { ...hostedOptions().hosted, publicOrigin: localOrigin },
	});
	hosts.push(loopback);
	const started = await api(loopback, '/api/session', {
		method: 'POST',
		headers: {
			Host: 'localhost:4197',
			Origin: localOrigin,
		},
		body: { preset },
	});
	expect(started.status).toBe(201);
	expect(started.headers.get('set-cookie')).not.toContain('Secure');
	const local = await startHost({ projectModule: fixture });
	hosts.push(local);
	const localInfo = await (await fetch(`${local.url}/api/host`)).json();
	validateHostInfo(localInfo);
	expect(localInfo).toMatchObject({ mode: 'local', run: { state: 'active', session: false } });
	expect(localInfo).not.toHaveProperty('limits');
	expect(localInfo.run).not.toHaveProperty('startedAt');
});

test('CLI rejects invalid hosted flag combinations', () => {
	const cli = resolve(process.cwd(), 'lib/host/cli.js');
	for (const args of [
		['--public-origin', origin],
		['--access', 'trusted-proxy'],
		['--max-runs', '2'],
		['--public-origin', origin, '--access', 'authorize', '--build-revision', 'abc123'],
		['--public-origin', origin, '--access', 'trusted-proxy'],
	]) {
		const result = spawnSync(process.execPath, [cli, '--project', fixture, ...args], {
			cwd: process.cwd(),
			env: { ...process.env, SLIPHER_LAB_BUILD_REVISION: '' },
			encoding: 'utf8',
		});
		expect(result.status).toBe(1);
	}
});

test('CLI SIGTERM closes its hosted child', async () => {
	const cli = spawn(
		process.execPath,
		[
			'lib/host/cli.js',
			'--project',
			fixture,
			'--public-origin',
			origin,
			'--access',
			'trusted-proxy',
			'--build-ref',
			'main',
			'--max-runs',
			'2',
			'--idle-ttl-ms',
			'10000',
			'--max-run-ms',
			'30000',
			'--child-env',
			'LAB_FORWARDED',
			'--export-module',
			'./lab/project',
		],
		{
			cwd: process.cwd(),
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, SLIPHER_LAB_BUILD_REVISION: 'abc123' },
		},
	);
	let stderr = '';
	cli.stderr.on('data', chunk => {
		stderr += String(chunk);
	});
	try {
		const url = await new Promise<string>((done, reject) => {
			const timer = setTimeout(() => reject(new Error(stderr)), 5000);
			cli.once('exit', code => {
				clearTimeout(timer);
				reject(new Error(`CLI exited ${code}: ${stderr}`));
			});
			cli.stdout.once('data', chunk => {
				clearTimeout(timer);
				done(String(chunk).trim());
			});
		});
		const host = { url } as LabHost;
		expect(await (await api(host, '/api/host')).json()).toMatchObject({
			build: { revision: 'abc123', ref: 'main' },
			limits: { maxRuns: 2, idleTtlMs: 10000, maxRunMs: 30000 },
		});
		const a = await start(host);
		const identity = (await (await rpc(host, a.cookie!, 'session.inspectProject', { name: 'identity' })).json()) as {
			value: { pid: number };
		};
		cli.kill('SIGTERM');
		await new Promise(done => cli.once('exit', done));
		expect(() => process.kill(identity.value.pid, 0)).toThrow();
	} finally {
		if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
	}
});
