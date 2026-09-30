#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { type BuildInfo, type HostedOptions, startHost } from './index';

function usage(): never {
	throw new Error(
		'Usage: slipher-lab --project <module> [--cwd <dir>] [--data <dir>] [--port N] [--host <address>] [--rpc-timeout-ms N] [--node-arg <arg>]... [--ui <dir>] [--public-origin <url> --access trusted-proxy] [--max-runs N] [--idle-ttl-ms N] [--max-run-ms N] [--child-env NAME]... [--export-module <spec>] [--build-revision <rev>] [--build-ref <ref>] [--build-url <url>] [--build-time <iso>]',
	);
}
async function main(): Promise<void> {
	let projectModule: string | undefined;
	let cwd: string | undefined;
	let port = 0;
	let hostname = '127.0.0.1';
	let rpcTimeoutMs: number | undefined;
	let uiDir: string | undefined;
	let dataDir: string | undefined;
	let publicOrigin: string | undefined;
	let access: string | undefined;
	let maxRuns: number | undefined;
	let idleTtlMs: number | undefined;
	let maxRunMs: number | undefined;
	let exportModule: string | undefined;
	let buildRevision = process.env.SLIPHER_LAB_BUILD_REVISION;
	let buildRef = process.env.SLIPHER_LAB_BUILD_REF;
	let buildUrl = process.env.SLIPHER_LAB_BUILD_URL;
	let buildTime = process.env.SLIPHER_LAB_BUILD_TIME;
	const childEnv: string[] = [];
	const execArgv: string[] = [];
	for (let i = 2; i < process.argv.length; i++) {
		const flag = process.argv[i];
		const value = process.argv[++i];
		if (!value) usage();
		switch (flag) {
			case '--project':
				projectModule = resolve(value);
				break;
			case '--cwd':
				cwd = resolve(value);
				break;
			case '--port':
				port = Number(value);
				break;
			case '--host':
				hostname = value;
				break;
			case '--rpc-timeout-ms':
				rpcTimeoutMs = Number(value);
				break;
			case '--node-arg':
				execArgv.push(value);
				break;
			case '--ui':
				uiDir = resolve(value);
				break;
			case '--data':
				dataDir = resolve(value);
				break;
			case '--public-origin':
				publicOrigin = value;
				break;
			case '--access':
				access = value;
				break;
			case '--max-runs':
				maxRuns = Number(value);
				break;
			case '--idle-ttl-ms':
				idleTtlMs = Number(value);
				break;
			case '--max-run-ms':
				maxRunMs = Number(value);
				break;
			case '--child-env':
				childEnv.push(value);
				break;
			case '--export-module':
				exportModule = value;
				break;
			case '--build-revision':
				buildRevision = value;
				break;
			case '--build-ref':
				buildRef = value;
				break;
			case '--build-url':
				buildUrl = value;
				break;
			case '--build-time':
				buildTime = value;
				break;
			default:
				usage();
		}
	}
	if (!projectModule) usage();
	if (
		(publicOrigin && access !== 'trusted-proxy') ||
		(!publicOrigin &&
			(access || maxRuns !== undefined || idleTtlMs !== undefined || maxRunMs !== undefined || childEnv.length))
	)
		usage();
	if (publicOrigin && !buildRevision) usage();
	const build: BuildInfo | undefined = buildRevision
		? {
				revision: buildRevision,
				...(buildRef ? { ref: buildRef } : {}),
				...(buildUrl ? { url: buildUrl } : {}),
				...(buildTime ? { builtAt: buildTime } : {}),
			}
		: undefined;
	const hosted: HostedOptions | undefined = publicOrigin
		? {
				publicOrigin,
				access: { mode: 'trusted-proxy' },
				...(maxRuns !== undefined ? { maxRuns } : {}),
				...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
				...(maxRunMs !== undefined ? { maxRunMs } : {}),
			}
		: undefined;
	if (rpcTimeoutMs !== undefined && (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0))
		throw new TypeError('rpcTimeoutMs must be a positive integer');
	if (!uiDir) {
		try {
			uiDir = resolve(dirname(require.resolve('@slipher/lab-ui/package.json')), 'dist');
		} catch {
			try {
				uiDir = dirname(require.resolve('@slipher/lab-ui/dist/index.html'));
			} catch {
				/* optional UI */
			}
		}
	}
	const host = await startHost({
		projectModule,
		cwd,
		port,
		hostname,
		rpcTimeoutMs,
		uiDir,
		dataDir,
		hosted,
		build,
		...(childEnv.length ? { childEnv } : {}),
		exportModule,
		...(execArgv.length ? { execArgv } : {}),
	});
	process.stdout.write(`${host.url}\n`);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		void host.close().then(
			() => process.exit(0),
			error => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exit(1);
			},
		);
	};
	process.on('SIGINT', close);
	process.on('SIGTERM', close);
}
void main().catch(error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
