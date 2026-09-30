#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { errorText } from './http';
import { type BuildInfo, type HostedOptions, startHost } from './index';

const USAGE =
	'Usage: slipher-lab --project <module> [--cwd <dir>] [--data <dir>] [--port N] [--host <address>] [--rpc-timeout-ms N] [--node-arg <arg>]... [--ui <dir>] [--public-origin <url> --access trusted-proxy] [--max-runs N] [--idle-ttl-ms N] [--max-run-ms N] [--child-env NAME]... [--export-module <spec>] [--build-revision <rev>] [--build-ref <ref>] [--build-url <url>] [--build-time <iso>]';

function usage(): never {
	throw new Error(USAGE);
}

interface CliArgs {
	projectModule?: string;
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
		// The CLI supports only trusted-proxy access; `authorize` takes a function and is API-only.
		if (args.access !== 'trusted-proxy' || !args.buildRevision) usage();
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

function hostedOptions({ publicOrigin, maxRuns, idleTtlMs, maxRunMs }: CliArgs): HostedOptions | undefined {
	return publicOrigin ? { publicOrigin, access: { mode: 'trusted-proxy' }, maxRuns, idleTtlMs, maxRunMs } : undefined;
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
	const args = parseArgs(process.argv.slice(2));
	const host = await startHost({
		projectModule: args.projectModule,
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
