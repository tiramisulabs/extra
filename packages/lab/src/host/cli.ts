#!/usr/bin/env node
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { previewCommand } from '../preview/cli';
import { applyDeploymentEnvironment } from '../preview/deploy';
import { initializePreview } from '../preview/init';
import { errorText } from '../shared';
import { type BuildInfo, type HostAccess, type HostedOptions, startHost } from './index';

const USAGE =
	'Usage: slipher-lab --project <module> [--pr <snapshot.json>] [--cwd <dir>] [--data <dir>] [--port N] [--host <address>] [--rpc-timeout-ms N] [--node-arg <arg>]... [--ui <dir>] [--public-origin <url> --access trusted-proxy|basic] [--max-runs N] [--idle-ttl-ms N] [--max-run-ms N] [--child-env NAME]... [--export-module <spec>] [--build-revision <rev>] [--build-ref <ref>] [--build-url <url>] [--build-time <iso>]';

function usage(): never {
	throw new Error(USAGE);
}

interface CliArgs {
	projectModule?: string;
	pullRequestFile?: string;
	cwd?: string;
	dataDir?: string;
	uiDir?: string;
	port: number;
	hostname: string;
	rpcTimeoutMs?: number;
	nodeArgs: string[];
	publicOrigin?: string;
	access?: string;
	maxRuns?: number;
	idleTtlMs?: number;
	maxRunMs?: number;
	childEnv: string[];
	exportModule?: string;
	buildRevision?: string;
	buildRef?: string;
	buildUrl?: string;
	buildTime?: string;
}

// Every flag takes exactly one value, which may itself start with `-` (for example `--node-arg --import`).
const FLAGS = new Map<string, (args: CliArgs, value: string) => void>([
	['--project', (args, value) => (args.projectModule = resolve(value))],
	['--pr', (args, value) => (args.pullRequestFile = resolve(value))],
	['--cwd', (args, value) => (args.cwd = resolve(value))],
	['--data', (args, value) => (args.dataDir = resolve(value))],
	['--ui', (args, value) => (args.uiDir = resolve(value))],
	['--port', (args, value) => (args.port = Number(value))],
	['--host', (args, value) => (args.hostname = value)],
	['--rpc-timeout-ms', (args, value) => (args.rpcTimeoutMs = Number(value))],
	['--node-arg', (args, value) => args.nodeArgs.push(value)],
	['--public-origin', (args, value) => (args.publicOrigin = value)],
	['--access', (args, value) => (args.access = value)],
	['--max-runs', (args, value) => (args.maxRuns = Number(value))],
	['--idle-ttl-ms', (args, value) => (args.idleTtlMs = Number(value))],
	['--max-run-ms', (args, value) => (args.maxRunMs = Number(value))],
	['--child-env', (args, value) => args.childEnv.push(value)],
	['--export-module', (args, value) => (args.exportModule = value)],
	['--build-revision', (args, value) => (args.buildRevision = value)],
	['--build-ref', (args, value) => (args.buildRef = value)],
	['--build-url', (args, value) => (args.buildUrl = value)],
	['--build-time', (args, value) => (args.buildTime = value)],
]);

function parseArgs(argv: string[]): CliArgs & { projectModule: string } {
	const args: CliArgs = {
		port: 0,
		hostname: '127.0.0.1',
		nodeArgs: [],
		childEnv: [],
		publicOrigin: process.env.SLIPHER_LAB_PUBLIC_ORIGIN,
		buildRevision: process.env.SLIPHER_LAB_BUILD_REVISION,
		buildRef: process.env.SLIPHER_LAB_BUILD_REF,
		buildUrl: process.env.SLIPHER_LAB_BUILD_URL,
		buildTime: process.env.SLIPHER_LAB_BUILD_TIME,
	};
	for (let i = 0; i < argv.length; i += 2) {
		const set = FLAGS.get(argv[i]);
		const value = argv[i + 1];
		if (!set || !value) usage();
		set(args, value);
	}
	const { projectModule } = args;
	if (!projectModule) usage();
	if (args.publicOrigin) {
		// Custom authorization callbacks are API-only; Basic login is also available through the CLI.
		if (!['trusted-proxy', 'basic'].includes(args.access ?? '') || !args.buildRevision) usage();
	} else if (
		args.access !== undefined ||
		args.maxRuns !== undefined ||
		args.idleTtlMs !== undefined ||
		args.maxRunMs !== undefined ||
		args.childEnv.length > 0
	)
		usage();
	return { ...args, projectModule };
}

function buildInfo({ buildRevision, buildRef, buildUrl, buildTime }: CliArgs): BuildInfo | undefined {
	if (!buildRevision) return undefined;
	return {
		revision: buildRevision,
		...(buildRef ? { ref: buildRef } : {}),
		...(buildUrl ? { url: buildUrl } : {}),
		...(buildTime ? { builtAt: buildTime } : {}),
	};
}

function hostedOptions({
	publicOrigin,
	access: mode,
	maxRuns,
	idleTtlMs,
	maxRunMs,
}: CliArgs): HostedOptions | undefined {
	if (!publicOrigin) return undefined;
	const access: HostAccess = mode === 'basic' ? basicAccess() : { mode: 'trusted-proxy' };
	return { publicOrigin, access, maxRuns, idleTtlMs, maxRunMs };
}

function basicAccess(): HostAccess {
	const password = process.env.SLIPHER_LAB_PASSWORD;
	if (!password) throw new Error('SLIPHER_LAB_PASSWORD is required for --access basic');
	const expected = Buffer.from(`Basic ${Buffer.from(`lab:${password}`).toString('base64')}`);
	return {
		mode: 'authorize',
		challenge: 'Basic realm="Discord Lab"',
		authorize: request => {
			const received = Buffer.from(request.headers.authorization ?? '');
			return received.length === expected.length && timingSafeEqual(received, expected);
		},
	};
}

/** The UI is an optional peer dependency. */
function installedUiDir(): string | undefined {
	try {
		return resolve(dirname(require.resolve('@slipher/lab-ui/package.json')), 'dist');
	} catch {
		try {
			return dirname(require.resolve('@slipher/lab-ui/dist/index.html'));
		} catch {
			return undefined;
		}
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === 'init') return initializePreview(argv.slice(1));
	if (argv[0] === 'preview') return previewCommand(argv.slice(1));
	applyDeploymentEnvironment();
	const args = parseArgs(argv);
	const host = await startHost({
		projectModule: args.projectModule,
		pullRequest: args.pullRequestFile ? JSON.parse(await readFile(args.pullRequestFile, 'utf8')) : undefined,
		cwd: args.cwd,
		port: args.port,
		hostname: args.hostname,
		rpcTimeoutMs: args.rpcTimeoutMs,
		uiDir: args.uiDir ?? installedUiDir(),
		dataDir: args.dataDir,
		hosted: hostedOptions(args),
		build: buildInfo(args),
		childEnv: args.childEnv,
		exportModule: args.exportModule,
		execArgv: args.nodeArgs.length ? args.nodeArgs : undefined,
	});
	process.stdout.write(`${host.url}\n`);
	let closing = false;
	const close = () => {
		if (closing) return;
		closing = true;
		host.close().then(
			() => process.exit(0),
			error => {
				process.stderr.write(`${errorText(error)}\n`);
				process.exit(1);
			},
		);
	};
	process.on('SIGINT', close);
	process.on('SIGTERM', close);
}

main().catch(error => {
	process.stderr.write(`${errorText(error)}\n`);
	process.exitCode = 1;
});
