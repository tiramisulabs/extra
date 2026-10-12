import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { type LabHost, startHost } from '../src/host';
import { previewCommand } from '../src/preview/cli';
import type { PreviewConfig } from '../src/preview/config';
import { previewOrigin } from '../src/preview/deploy';
import { deployDokploy, destroyDokploy } from '../src/preview/dokploy';
import { assertCurrent, capturePullRequest, type PreviewSnapshot } from '../src/preview/github';
import { closeHosts, hostedRequest, tempDataDir } from './helpers.mjs';

const hosts: LabHost[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	await closeHosts(hosts);
});

test('Dokploy updates one owned application, rolls back failed creation and never deletes another preview', async () => {
	vi.stubEnv('SLIPHER_LAB_ENV', '');
	vi.stubEnv('SLIPHER_LAB_DOKPLOY_KEY', 'fixture-key');
	vi.stubEnv('SLIPHER_LAB_REGISTRY_USERNAME', 'fixture');
	vi.stubEnv('SLIPHER_LAB_REGISTRY_TOKEN', 'fixture-token');
	vi.stubEnv('SLIPHER_LAB_PASSWORD', 'quoted"$value\\nline\nnext');
	const applications = [{ applicationId: 'other', name: 'lab-9-pr-2', description: 'slipher-lab:lab-9-pr-2' }];
	const domains: { host: string }[] = [];
	let pullRequestState = 'open';
	let failEnvironment = false;
	let sequence = 0;
	const server = createServer(async (req, res) => {
		try {
			if (!req.url?.startsWith('/repos/') && req.headers['x-api-key'] !== 'fixture-key') {
				res.writeHead(401);
				res.end('{}');
				return;
			}
			const url = new URL(req.url!, 'http://localhost');
			let input: Record<string, unknown> = {};
			if (req.method === 'POST') {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				input = JSON.parse(Buffer.concat(chunks).toString());
			}
			let output: unknown = true;
			switch (url.pathname) {
				case '/repos/fixture/bot/pulls/1':
					output = { state: pullRequestState };
					break;
				case '/repos/fixture/bot/deployments':
					output = [];
					break;
				case '/api/environment.one':
					output = { applications };
					break;
				case '/api/application.create': {
					const app = {
						applicationId: `app-${++sequence}`,
						name: String(input.name),
						description: String(input.description),
					};
					applications.push(app);
					output = app;
					break;
				}
				case '/api/application.saveEnvironment':
					if (failEnvironment) {
						res.writeHead(500);
						res.end('{}');
						return;
					}
					break;
				case '/api/domain.byApplicationId':
					output = domains;
					break;
				case '/api/domain.create':
					domains.push({ host: String(input.host) });
					break;
				case '/api/application.delete':
					applications.splice(
						applications.findIndex(app => app.applicationId === input.applicationId),
						1,
					);
					break;
				case '/api/application.saveDockerProvider':
				case '/api/application.deploy':
					break;
				default:
					res.writeHead(404);
					res.end('{}');
					return;
			}
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(output));
		} catch {
			res.writeHead(500);
			res.end('{}');
		}
	});
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	const snapshot: PreviewSnapshot = {
		repository: 'fixture/bot',
		repositoryId: 9,
		number: 1,
		headRefOid: 'a'.repeat(40),
		body: '',
		runUrl: 'https://github.com/fixture/bot/actions/runs/1/attempts/2',
	};
	const config: PreviewConfig = {
		project: 'dist/lab/project.js',
		cwd: '.',
		install: 'npm ci',
		build: 'npm run build',
		childEnv: [],
		domain: 'example.invalid',
		provider: {
			type: 'dokploy',
			url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			environmentId: 'fixture',
		},
	};
	const directory = await tempDataDir();
	const configPath = resolve(directory, 'lab.preview.json');
	const eventPath = resolve(directory, 'event.json');
	await writeFile(configPath, JSON.stringify(config));
	await writeFile(eventPath, JSON.stringify({ repository: { id: 9 }, pull_request: { number: 1 } }));
	vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
	vi.stubEnv('GITHUB_REPOSITORY', 'fixture/bot');
	vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
	vi.stubEnv('GITHUB_API_URL', config.provider.type === 'dokploy' ? config.provider.url : '');
	const origin = previewOrigin(config, snapshot);
	const options = {
		projectModule: resolve(process.cwd(), 'test/fixtures/project.cjs'),
		hosted: { publicOrigin: origin, access: { mode: 'authorize' as const, authorize: () => true } },
		dataDir: await tempDataDir(),
	};
	const old = await startHost({ ...options, build: { revision: snapshot.headRefOid, url: 'previous-workflow' } });
	hosts.push(old);
	const current = await startHost({
		...options,
		dataDir: await tempDataDir(),
		build: { revision: snapshot.headRefOid, url: snapshot.runUrl },
	});
	hosts.push(current);
	const network = globalThis.fetch;
	let probes = 0;
	vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).startsWith(origin)) {
			const destination = probes++ === 0 ? old : current;
			return hostedRequest(destination, origin, new URL(String(input)).pathname, {
				headers: Object.fromEntries(new Headers(init?.headers)),
			});
		}
		return network(input, init);
	});
	try {
		const image = `ghcr.io/fixture/bot@sha256:${'b'.repeat(64)}`;
		await deployDokploy(config, snapshot, image);
		expect(probes).toBeGreaterThan(1);
		await deployDokploy(config, snapshot, image);
		expect(applications).toHaveLength(2);
		await previewCommand(['destroy', '--config', configPath]);
		expect(applications).toHaveLength(2);
		pullRequestState = 'closed';
		await previewCommand(['destroy', '--config', configPath]);
		await previewCommand(['destroy', '--config', configPath]);
		expect(applications.map(app => app.applicationId)).toEqual(['other']);
		failEnvironment = true;
		await expect(deployDokploy(config, snapshot, image)).rejects.toThrow('saveEnvironment');
		expect(applications.map(app => app.applicationId)).toEqual(['other']);
		applications.push({ applicationId: 'unowned', name: 'lab-9-pr-1', description: 'manual deployment' });
		await expect(destroyDokploy(config, snapshot)).rejects.toThrow('not owned');
		expect(applications.map(app => app.applicationId)).toEqual(['other', 'unowned']);
	} finally {
		await new Promise<void>(done => server.close(() => done()));
	}
});

test('CI captures one PR recipe and refuses a checkout that no longer matches the PR head', async () => {
	const directory = await tempDataDir();
	await writeFile(resolve(directory, 'package.json'), '{}');
	for (const args of [
		['init', '-q'],
		['add', 'package.json'],
		['-c', 'user.name=Lab', '-c', 'user.email=lab@example.invalid', 'commit', '-qm', 'fixture'],
	])
		execFileSync('git', args, { cwd: directory });
	const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
	const event = resolve(directory, 'event.json');
	await writeFile(
		event,
		JSON.stringify({ repository: { id: 9, full_name: 'fixture/bot' }, pull_request: { number: 3 } }),
	);
	let remoteHead = head;
	let body = '```json slipher-lab\n{"scenario":{"id":"workspace","version":1},"params":{"active":false}}\n```';
	const server = createServer((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ state: 'open', head: { sha: remoteHead }, body }));
	});
	await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
	for (const [key, value] of Object.entries({
		GITHUB_EVENT_PATH: event,
		GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		GITHUB_TOKEN: 'fixture-token',
		GITHUB_RUN_ID: '10',
		GITHUB_RUN_ATTEMPT: '1',
	}))
		vi.stubEnv(key, value);
	try {
		const captured = await capturePullRequest(directory);
		body = 'edited after capture';
		await assertCurrent(captured);
		expect(captured.body).toContain('"active":false');
		remoteHead = 'b'.repeat(40);
		await expect(capturePullRequest(directory)).rejects.toThrow('changed');
		await expect(assertCurrent(captured)).rejects.toThrow('changed');
	} finally {
		await new Promise<void>(done => server.close(() => done()));
	}
});
