import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { describeChildProject } from '../child';
import type { BuildInfo, ProjectDescription } from '../protocol';
import { HostedRuns, type HostLimits, LocalRuns } from './registry';
import { createRequestListener, type HostContext } from './routes';

export interface HostOptions {
	projectModule: string;
	cwd?: string;
	execArgv?: string[];
	env?: Record<string, string>;
	hostname?: string;
	port?: number;
	uiDir?: string;
	dataDir?: string;
	startTimeoutMs?: number;
	disposeTimeoutMs?: number;
	rpcTimeoutMs?: number;
	hosted?: HostedOptions;
	build?: BuildInfo;
	inheritEnv?: boolean;
	childEnv?: string[];
	exportModule?: string;
}
export type { BuildInfo };
export type HostAccess =
	| { mode: 'trusted-proxy' }
	| { mode: 'authorize'; authorize(req: IncomingMessage): boolean | Promise<boolean> };
export interface HostedOptions {
	publicOrigin: string;
	access: HostAccess;
	maxRuns?: number;
	idleTtlMs?: number;
	maxRunMs?: number;
}
export interface LabHost {
	url: string;
	close(): Promise<void>;
}

const LOCAL_BIND_HOSTNAMES = ['127.0.0.1', '::1', 'localhost'];
/** `URL.hostname` values allowed for a plain-HTTP public origin. */
const LOOPBACK_URL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const BUILD_REVISION = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_MAX_RUNS = 6;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_RUN_MS = 2 * 60 * 60_000;

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
	return value;
}

interface HostedConfig {
	publicOrigin: URL;
	access: HostAccess;
	limits: HostLimits;
}

function resolveHostedConfig(hosted: HostedOptions, options: HostOptions): HostedConfig {
	if (options.inheritEnv === true) throw new TypeError('Hosted mode cannot inherit child environment');
	const limits = {
		maxRuns: positiveInteger(hosted.maxRuns ?? DEFAULT_MAX_RUNS, 'maxRuns'),
		idleTtlMs: positiveInteger(hosted.idleTtlMs ?? DEFAULT_IDLE_TTL_MS, 'idleTtlMs'),
		maxRunMs: positiveInteger(hosted.maxRunMs ?? DEFAULT_MAX_RUN_MS, 'maxRunMs'),
	};
	if (!options.build?.revision || !BUILD_REVISION.test(options.build.revision))
		throw new TypeError('Hosted mode requires a valid build.revision');
	// Checked at runtime because JavaScript callers can omit access entirely.
	const { access } = hosted;
	if (access?.mode !== 'trusted-proxy' && (access?.mode !== 'authorize' || typeof access.authorize !== 'function'))
		throw new TypeError('Hosted mode requires explicit access');
	let publicOrigin: URL;
	try {
		publicOrigin = new URL(hosted.publicOrigin);
	} catch {
		throw new TypeError('Invalid publicOrigin');
	}
	if (
		(publicOrigin.protocol !== 'http:' && publicOrigin.protocol !== 'https:') ||
		hosted.publicOrigin !== publicOrigin.origin
	)
		throw new TypeError('publicOrigin must be an http(s) origin without a path');
	if (publicOrigin.protocol === 'http:' && !LOOPBACK_URL_HOSTNAMES.includes(publicOrigin.hostname))
		throw new TypeError('HTTP publicOrigin must use loopback');
	return { publicOrigin, access, limits };
}

export async function startHost(options: HostOptions): Promise<LabHost> {
	const hostname = options.hostname ?? '127.0.0.1';
	const port = options.port ?? 0;
	if (!options.hosted && !LOCAL_BIND_HOSTNAMES.includes(hostname))
		throw new TypeError('Host must bind to 127.0.0.1, ::1 or localhost');
	const hosted = options.hosted && resolveHostedConfig(options.hosted, options);
	if (options.rpcTimeoutMs !== undefined) positiveInteger(options.rpcTimeoutMs, 'rpcTimeoutMs');
	if (!isAbsolute(options.projectModule)) throw new TypeError('projectModule must be an absolute path');
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');

	const uiRoot = options.uiDir ? await realpath(options.uiDir) : undefined;
	const dataDir = options.dataDir ? resolve(options.dataDir) : resolve(dirname(options.projectModule), '.slipher-lab');
	const instanceId = randomUUID();
	const childOptions = {
		projectModule: options.projectModule,
		cwd: options.cwd,
		execArgv: options.execArgv,
		env: options.env,
		startTimeoutMs: options.startTimeoutMs,
		disposeTimeoutMs: options.disposeTimeoutMs,
		rpcTimeoutMs: options.rpcTimeoutMs,
		inheritEnv: hosted ? false : options.inheritEnv,
		childEnv: options.childEnv,
	};
	// Hosted mode serves one fixed build and describes it once; local mode describes on demand so rebuilds show up.
	const cachedDescription = hosted ? await describeChildProject(childOptions) : undefined;
	const runs = hosted
		? await HostedRuns.open(instanceId, dataDir, hosted.limits, hosted.publicOrigin.protocol === 'https:')
		: new LocalRuns(dataDir);
	// Describe children in flight, awaited by close() so none outlive the host.
	const describes = new Set<Promise<ProjectDescription>>();
	const describeProject = (): Promise<ProjectDescription> => {
		if (cachedDescription) return Promise.resolve(cachedDescription);
		const describing = describeChildProject(childOptions);
		describes.add(describing);
		const forget = () => describes.delete(describing);
		describing.then(forget, forget);
		return describing;
	};
	let closed = false;
	const context: HostContext = {
		options,
		hosted,
		instanceId,
		uiRoot,
		runs,
		childOptions,
		describeProject,
		isClosed: () => closed,
	};

	const server = createServer(createRequestListener(context));
	try {
		await new Promise<void>((done, reject) => {
			server.once('error', reject);
			server.listen(port, hostname, done);
		});
	} catch (error) {
		server.close();
		throw error;
	}
	const address = server.address() as AddressInfo;
	return {
		url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
		async close() {
			if (closed) return;
			closed = true;
			const [cleanup] = await Promise.allSettled([runs.close()]);
			await Promise.allSettled(describes);
			await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())));
			if (cleanup.status === 'rejected') throw cleanup.reason;
		},
	};
}
