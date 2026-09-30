import { randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createChildSession, describeChildProject } from '../child';
import type { Checkpoint, JsonValue, Preset, Session, SessionEvent } from '../index';
import {
	type BridgeRequest,
	type BridgeResponse,
	type HostInfo,
	PROTOCOL_VERSION,
	validateBridgeRequest,
	validateCheckpoint,
	validateCheckpointName,
} from '../protocol';
import { replaySession } from '../runtime';
import { exportTest } from '../runtime/checkpoint';

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
export interface BuildInfo {
	revision: string;
	ref?: string;
	url?: string;
	builtAt?: string;
}
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
const MAX_BODY = 1024 * 1024;
const LAB_VERSION: string = require('../../package.json').version;
const EVENT_HISTORY = 256;
const mime: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};
class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly detail?: Record<string, string>,
	) {
		super(message);
	}
}
type RunEndReason = 'expired' | 'max-lifetime' | 'stopped' | 'shutdown';
interface Run {
	id: string;
	state: 'active' | 'ending' | 'ended';
	endReason?: RunEndReason;
	endTask?: Promise<void>;
	session?: Session;
	serial: Promise<void>;
	pending: number;
	eventId: number;
	history: { id: number; type: string; data: JsonValue }[];
	streams: Set<ServerResponse>;
	checkpointsDir: string;
	startedAt: number;
	lastActivity: number;
}
function newRun(id: string, checkpointsDir: string): Run {
	return {
		id,
		state: 'active',
		serial: Promise.resolve(),
		pending: 0,
		eventId: 0,
		history: [],
		streams: new Set(),
		checkpointsDir,
		startedAt: Date.now(),
		lastActivity: Date.now(),
	};
}
function queued<T>(run: Run, task: () => Promise<T>): Promise<T> {
	run.pending++;
	const result = run.serial
		.then(() => {
			assertActive(run);
			return task();
		})
		.finally(() => {
			run.pending--;
			run.lastActivity = Date.now();
		});
	run.serial = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
function assertActive(run: Run): void {
	if (run.state !== 'active')
		throw new HttpError(409, 'Run has ended', {
			code: 'run-ended',
			...(run.endReason ? { reason: run.endReason } : {}),
		});
}
function publish(run: Run, type: string, data: JsonValue): void {
	const event = { id: ++run.eventId, type, data };
	run.history.push(event);
	if (run.history.length > EVENT_HISTORY) run.history.shift();
	for (const stream of run.streams) stream.write(`id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function localAuthority(value: string | undefined): boolean {
	return !!value && /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(value);
}
function permitted(req: IncomingMessage): boolean {
	if (!localAuthority(req.headers.host)) return false;
	if (!req.headers.origin) return true;
	try {
		const origin = new URL(req.headers.origin);
		return ['http:', 'https:'].includes(origin.protocol) && localAuthority(origin.host);
	} catch {
		return false;
	}
}
async function body(req: IncomingMessage, emptyAllowed = false): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > MAX_BODY) throw new HttpError(413, 'Request body exceeds 1 MiB');
		chunks.push(bytes);
	}
	if (size === 0 && emptyAllowed) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} catch {
		throw new HttpError(400, 'Invalid JSON body');
	}
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(value));
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function bridgeResponse(id: number, ok: boolean, value?: JsonValue, error?: string): BridgeResponse {
	return { version: PROTOCOL_VERSION, id, type: 'result', ok, ...(ok ? { value: value ?? null } : { error }) };
}
async function invoke(session: Session, request: BridgeRequest): Promise<JsonValue> {
	switch (request.type) {
		case 'session.act':
			return (await session.act(request.payload as unknown as Parameters<Session['act']>[0])) as unknown as JsonValue;
		case 'session.view': {
			const { actor, channelRef } = request.payload as { actor: string; channelRef: string };
			return (await session.view(actor, channelRef)) as unknown as JsonValue;
		}
		case 'session.inspect':
			return (await session.inspect()) as unknown as JsonValue;
		case 'session.describe':
			return (await session.describe()) as unknown as JsonValue;
		case 'session.commandSchemas':
			return (await session.commandSchemas()) as unknown as JsonValue;
		case 'session.inspectProject': {
			const { name, args } = request.payload as { name: string; args?: JsonValue };
			return await session.inspectProject(name, args);
		}
		case 'session.log':
			return (await session.log()) as unknown as JsonValue;
		default:
			throw new HttpError(400, `Use /api/session for ${request.type}`);
	}
}

export async function startHost(options: HostOptions): Promise<LabHost> {
	const hostname = options.hostname ?? '127.0.0.1';
	const port = options.port ?? 0;
	const hosted = options.hosted;
	if (!hosted && !['127.0.0.1', '::1', 'localhost'].includes(hostname))
		throw new TypeError('Host must bind to 127.0.0.1, ::1 or localhost');
	if (hosted && options.inheritEnv === true) throw new TypeError('Hosted mode cannot inherit child environment');
	const positive = (value: number, name: string) => {
		if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
		return value;
	};
	const limits = hosted
		? {
				maxRuns: positive(hosted.maxRuns ?? 6, 'maxRuns'),
				idleTtlMs: positive(hosted.idleTtlMs ?? 30 * 60_000, 'idleTtlMs'),
				maxRunMs: positive(hosted.maxRunMs ?? 2 * 60 * 60_000, 'maxRunMs'),
			}
		: undefined;
	let publicOrigin: URL | undefined;
	if (hosted) {
		if (!options.build?.revision || !/^[A-Za-z0-9._-]{1,64}$/.test(options.build.revision))
			throw new TypeError('Hosted mode requires a valid build.revision');
		if (
			!hosted.access ||
			(hosted.access.mode !== 'trusted-proxy' &&
				(hosted.access.mode !== 'authorize' || typeof hosted.access.authorize !== 'function'))
		)
			throw new TypeError('Hosted mode requires explicit access');
		try {
			publicOrigin = new URL(hosted.publicOrigin);
		} catch {
			throw new TypeError('Invalid publicOrigin');
		}
		if (!['http:', 'https:'].includes(publicOrigin.protocol) || hosted.publicOrigin !== publicOrigin.origin)
			throw new TypeError('publicOrigin must be an http(s) origin without a path');
		if (publicOrigin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicOrigin.hostname))
			throw new TypeError('HTTP publicOrigin must use loopback');
	}
	if (options.rpcTimeoutMs !== undefined && (!Number.isSafeInteger(options.rpcTimeoutMs) || options.rpcTimeoutMs <= 0))
		throw new TypeError('rpcTimeoutMs must be a positive integer');
	if (!isAbsolute(options.projectModule)) throw new TypeError('projectModule must be an absolute path');
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
	const uiRoot = options.uiDir ? await realpath(options.uiDir) : undefined;
	const dataDir = resolve(options.dataDir ?? resolve(dirname(options.projectModule), '.slipher-lab'));
	const instanceId = randomUUID();
	const localRun = newRun('', dataDir);
	const runs = new Map<string, Run>();
	const tombstones = new Map<string, RunEndReason>();
	const cleanupErrors: Error[] = [];
	let closed = false;
	const describes = new Set<Promise<unknown>>();
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
	const cachedDescription = hosted ? await describeChildProject(childOptions) : undefined;
	if (hosted) {
		await rm(resolve(dataDir, 'runs'), { recursive: true, force: true });
		await mkdir(resolve(dataDir, 'runs'), { recursive: true });
	}
	const cookieId = (req: IncomingMessage): { instance: string; id: string } | undefined => {
		const value = req.headers.cookie
			?.split(';')
			.map(part => part.trim())
			.find(part => part.startsWith('slipher_lab_run='))
			?.slice('slipher_lab_run='.length);
		if (!value) return undefined;
		const dot = value.indexOf('.');
		return dot > 0 ? { instance: value.slice(0, dot), id: value.slice(dot + 1) } : { instance: '', id: value };
	};
	const findRun = (req: IncomingMessage): Run | undefined => {
		if (!hosted) return localRun;
		const cookie = cookieId(req);
		const found = cookie?.instance === instanceId ? runs.get(cookie.id) : undefined;
		return found?.state === 'active' ? found : undefined;
	};
	const endedError = (req: IncomingMessage): HttpError => {
		const cookie = cookieId(req);
		if (!cookie) return new HttpError(409, 'Run is missing', { code: 'run-missing' });
		const reason =
			cookie.instance !== instanceId ? 'restarted' : (runs.get(cookie.id)?.endReason ?? tombstones.get(cookie.id));
		return new HttpError(409, 'Run has ended', { code: 'run-ended', ...(reason ? { reason } : {}) });
	};
	const requireRun = (req: IncomingMessage): Run => {
		const run = findRun(req);
		if (run) {
			run.lastActivity = Date.now();
			return run;
		}
		throw endedError(req);
	};
	const createRun = (res: ServerResponse): Run => {
		if (!hosted || !limits || !publicOrigin) return localRun;
		if (runs.size >= limits.maxRuns) throw new HttpError(429, 'Run limit reached', { code: 'run-limit' });
		const id = randomBytes(32).toString('base64url');
		const run = newRun(id, resolve(dataDir, 'runs', id));
		runs.set(id, run);
		res.setHeader(
			'set-cookie',
			`slipher_lab_run=${instanceId}.${id}; HttpOnly; SameSite=Strict; Path=/${publicOrigin.protocol === 'https:' ? '; Secure' : ''}`,
		);
		return run;
	};
	const checkpointPath = (run: Run, name: string) => {
		try {
			validateCheckpointName(name);
		} catch (error) {
			throw new HttpError(400, errorText(error));
		}
		return resolve(run.checkpointsDir, `${name}.json`);
	};
	const safeCheckpointPath = async (run: Run, name: string): Promise<string> => {
		const file = checkpointPath(run, name);
		const root = await realpath(run.checkpointsDir);
		const inside = (path: string) => {
			const rest = relative(root, path);
			return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
		};
		try {
			if ((await lstat(file)).isSymbolicLink()) throw new HttpError(400, `Checkpoint "${name}" must not be a symlink`);
			if (!inside(await realpath(file))) throw new HttpError(400, `Checkpoint "${name}" is outside dataDir`);
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return file;
			throw error;
		}
		return file;
	};
	const loadCheckpoint = async (run: Run, name: string): Promise<Checkpoint> => {
		let value: unknown;
		try {
			const file = await safeCheckpointPath(run, name);
			const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				value = JSON.parse(await handle.readFile('utf8')) as unknown;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
				throw new HttpError(404, `Checkpoint "${name}" not found`);
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOOP')
				throw new HttpError(400, `Checkpoint "${name}" must not be a symlink`);
			if (error instanceof SyntaxError) throw new HttpError(400, `Checkpoint "${name}" contains invalid JSON`);
			throw error;
		}
		try {
			validateCheckpoint(value, cachedDescription ?? (await describeChildProject(childOptions)));
			if (value.labVersion !== LAB_VERSION)
				throw new Error(`Checkpoint lab version ${value.labVersion} is not supported (current ${LAB_VERSION})`);
		} catch (error) {
			throw new HttpError(400, errorText(error));
		}
		return value;
	};
	const checkRevision = (checkpoint: Checkpoint, accept: boolean): void => {
		if (options.build && checkpoint.build && checkpoint.build.revision !== options.build.revision && !accept)
			throw new HttpError(409, 'Checkpoint revision differs from this build', {
				code: 'revision-mismatch',
				checkpointRevision: checkpoint.build.revision,
				currentRevision: options.build.revision,
			});
	};
	const stop = async (run: Run) => {
		const previous = run.session;
		run.session = undefined;
		if (previous) await previous.dispose();
	};
	const endRun = async (run: Run, reason: RunEndReason): Promise<void> => {
		if (run.endTask) return run.endTask;
		run.state = 'ending';
		run.endReason = reason;
		run.endTask = (async () => {
			try {
				const disposal = run.serial.then(() => stop(run));
				run.serial = disposal.then(
					() => undefined,
					() => undefined,
				);
				const disposalResult = await Promise.allSettled([disposal]);
				const failures: unknown[] = disposalResult.filter(item => item.status === 'rejected').map(item => item.reason);
				try {
					publish(run, 'session-stopped', { reason });
				} catch (error) {
					failures.push(error);
				}
				for (const stream of run.streams) {
					try {
						stream.end();
					} catch (error) {
						failures.push(error);
					}
				}
				const removalResult = await Promise.allSettled([rm(run.checkpointsDir, { recursive: true, force: true })]);
				failures.push(...removalResult.filter(item => item.status === 'rejected').map(item => item.reason));
				if (failures.length) throw new AggregateError(failures, `Run ${run.id} cleanup failed`);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				cleanupErrors.push(failure);
				const detail = error instanceof AggregateError ? error.errors.map(errorText).join('; ') : failure.message;
				process.stderr.write(`Lab run ${run.id} cleanup failed: ${detail}\n`);
				throw failure;
			} finally {
				run.state = 'ended';
				runs.delete(run.id);
				tombstones.set(run.id, reason);
				if (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value ?? '');
			}
		})();
		return run.endTask;
	};
	const reaper = limits
		? setInterval(
				() => {
					const now = Date.now();
					for (const run of runs.values()) {
						if (run.state !== 'active' || run.pending > 0) continue;
						const reason =
							now - run.startedAt >= limits.maxRunMs
								? 'max-lifetime'
								: now - run.lastActivity >= limits.idleTtlMs
									? 'expired'
									: undefined;
						if (reason) void endRun(run, reason).catch(() => undefined);
					}
				},
				Math.min(30_000, Math.max(10, Math.min(limits.idleTtlMs, limits.maxRunMs) / 2)),
			)
		: undefined;
	reaper?.unref();
	const staticFile = async (pathname: string, res: ServerResponse, head = false) => {
		if (!uiRoot) {
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			res.end(head ? undefined : 'Lab UI is not installed. Install @slipher/lab-ui or pass --ui <dir>.');
			return;
		}
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			throw new HttpError(400, 'Invalid URL path');
		}
		const requested = resolve(uiRoot, `.${decoded}`);
		const inside = (path: string) =>
			path === uiRoot ||
			(!relative(uiRoot, path).startsWith(`..${sep}`) &&
				relative(uiRoot, path) !== '..' &&
				!isAbsolute(relative(uiRoot, path)));
		if (!inside(requested)) throw new HttpError(403, 'Path outside UI directory');
		let file = requested;
		try {
			if (!(await stat(file)).isFile()) file = resolve(uiRoot, 'index.html');
		} catch {
			if (extname(decoded)) throw new HttpError(404, 'File not found');
			file = resolve(uiRoot, 'index.html');
		}
		let actual: string;
		try {
			actual = await realpath(file);
			if (!inside(actual) || !(await stat(actual)).isFile()) throw new HttpError(403, 'Path outside UI directory');
		} catch (error) {
			if (error instanceof HttpError) throw error;
			throw new HttpError(404, 'File not found');
		}
		res.writeHead(200, {
			'content-type': mime[extname(actual)] ?? 'application/octet-stream',
			'x-content-type-options': 'nosniff',
		});
		if (head) res.end();
		else createReadStream(actual).pipe(res);
	};
	const server = createServer((req, res) => {
		let run: Run = localRun;
		void (async () => {
			const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
			if (hosted) {
				res.setHeader('x-frame-options', 'DENY');
				res.setHeader('referrer-policy', 'no-referrer');
				if (req.method === 'GET' && pathname === '/api/health') {
					sendJson(res, 200, { ok: true });
					return;
				}
				if (
					req.headers.host?.toLowerCase() !== publicOrigin?.host.toLowerCase() ||
					(req.headers.origin !== undefined && req.headers.origin !== hosted.publicOrigin) ||
					(req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== hosted.publicOrigin) ||
					(pathname.startsWith('/api/') &&
						req.headers['sec-fetch-site'] !== undefined &&
						req.headers['sec-fetch-site'] !== 'same-origin')
				)
					throw new HttpError(403, 'Host or Origin is not permitted');
				if (hosted.access.mode === 'authorize' && !(await hosted.access.authorize(req)))
					throw new HttpError(401, 'Unauthorized');
			} else if (!permitted(req)) throw new HttpError(403, 'Host and Origin must be local');
			if (closed) throw new HttpError(503, 'Host is closed');
			if (req.method === 'GET' && pathname === '/api/host') {
				const found = findRun(req);
				const cookie = cookieId(req);
				const reason =
					cookie && !found
						? cookie.instance !== instanceId
							? 'restarted'
							: (runs.get(cookie.id)?.endReason ?? tombstones.get(cookie.id))
						: undefined;
				const info: HostInfo = {
					mode: hosted ? 'hosted' : 'local',
					instanceId,
					labVersion: LAB_VERSION,
					protocolVersion: PROTOCOL_VERSION,
					...(options.build ? { build: options.build } : {}),
					...(limits ? { limits } : {}),
					run: found
						? {
								state: 'active',
								session: !!found.session,
								...(hosted && limits
									? {
											startedAt: new Date(found.startedAt).toISOString(),
											idleExpiresAt: new Date(found.lastActivity + limits.idleTtlMs).toISOString(),
											expiresAt: new Date(found.startedAt + limits.maxRunMs).toISOString(),
										}
									: {}),
							}
						: cookie
							? { state: 'ended', ...(reason ? { reason } : {}) }
							: { state: 'none' },
				};
				sendJson(res, 200, info);
				return;
			}
			if (req.method === 'GET' && pathname === '/api/events') {
				run = requireRun(req);
				res.writeHead(200, {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-cache, no-transform',
					connection: 'keep-alive',
				});
				res.write(': connected\n\n');
				const last = Number(req.headers['last-event-id'] ?? 0);
				if (Number.isSafeInteger(last) && last >= 0)
					for (const event of run.history)
						if (event.id > last)
							res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
				run.streams.add(res);
				const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
				res.on('close', () => {
					clearInterval(heartbeat);
					run?.streams.delete(res);
				});
				return;
			}
			if (req.method === 'GET' && pathname === '/api/describe') {
				const describing = cachedDescription ? Promise.resolve(cachedDescription) : describeChildProject(childOptions);
				describes.add(describing);
				try {
					sendJson(res, 200, await describing);
				} finally {
					describes.delete(describing);
				}
				return;
			}
			if (req.method === 'GET' && pathname === '/api/checkpoints') {
				run = requireRun(req);
				let names: string[];
				try {
					names = (await readdir(run.checkpointsDir))
						.filter(name => name.endsWith('.json'))
						.map(name => name.slice(0, -5))
						.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))
						.sort();
				} catch (error) {
					if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') names = [];
					else throw error;
				}
				sendJson(res, 200, { names });
				return;
			}
			if (req.method === 'POST' && pathname === '/api/checkpoints') {
				run = requireRun(req);
				const input = await body(req);
				if (!input || typeof input !== 'object' || !('checkpoint' in input))
					throw new HttpError(400, 'Expected { checkpoint }');
				const checkpoint: Record<string, unknown> = { ...(input.checkpoint as object) };
				if (hosted) delete (checkpoint as { projectModule?: string }).projectModule;
				else checkpoint.projectModule = options.projectModule;
				if (options.build && checkpoint.build === undefined) checkpoint.build = { revision: options.build.revision };
				try {
					validateCheckpoint(checkpoint, cachedDescription ?? (await describeChildProject(childOptions)));
					if (checkpoint.labVersion !== LAB_VERSION)
						throw new Error(
							`Checkpoint lab version ${checkpoint.labVersion} is not supported (current ${LAB_VERSION})`,
						);
				} catch (error) {
					throw new HttpError(400, errorText(error));
				}
				checkRevision(checkpoint, (input as { acceptRevision?: unknown }).acceptRevision === true);
				await queued(run, async () => {
					await mkdir(run.checkpointsDir, { recursive: true });
					assertActive(run);
					const file = await safeCheckpointPath(run, checkpoint.name);
					assertActive(run);
					const temp = resolve(run.checkpointsDir, `.${randomUUID()}.tmp`);
					try {
						await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
						assertActive(run);
						await rename(temp, file);
						assertActive(run);
					} finally {
						await unlink(temp).catch(error => {
							if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
							throw error;
						});
					}
				});
				sendJson(res, 201, { name: checkpoint.name });
				return;
			}
			if (pathname.startsWith('/api/checkpoints/')) {
				run = requireRun(req);
				run.lastActivity = Date.now();
				const parts = pathname.slice('/api/checkpoints/'.length).split('/');
				let name: string;
				try {
					name = decodeURIComponent(parts[0]);
				} catch {
					throw new HttpError(400, 'Invalid checkpoint name');
				}
				checkpointPath(run, name);
				if (req.method === 'GET' && parts.length === 1) {
					sendJson(res, 200, await loadCheckpoint(run, name));
					return;
				}
				if (req.method === 'POST' && parts.length === 2 && parts[1] === 'replay') {
					const replayInput = await body(req, true);
					const checkpoint = await loadCheckpoint(run, name);
					checkRevision(
						checkpoint,
						!!replayInput &&
							typeof replayInput === 'object' &&
							'acceptRevision' in replayInput &&
							replayInput.acceptRevision === true,
					);
					const result = await queued(run, async () => {
						if (run.session) {
							await stop(run);
							publish(run, 'session-stopped', { reason: 'replay' });
						}
						assertActive(run);
						return replaySession(createChildSession({ ...childOptions, preset: checkpoint.preset }), checkpoint);
					});
					sendJson(res, 200, { ok: true, log: result.log, inspect: result.inspect });
					return;
				}
				if (req.method === 'GET' && parts.length === 2 && parts[1] === 'export') {
					const format = new URL(req.url ?? '/', 'http://localhost').searchParams.get('format');
					if (format !== 'node' && format !== 'vitest')
						throw new HttpError(400, 'Export format must be node or vitest');
					const code = exportTest(await loadCheckpoint(run, name), {
						format,
						projectModule: hosted
							? (options.exportModule ?? './lab/project')
							: (options.exportModule ?? options.projectModule),
					});
					sendJson(res, 200, {
						code:
							hosted && !options.exportModule
								? `// Point this path at the project module before running this test.\n${code}`
								: code,
					});
					return;
				}
			}
			if (req.method === 'POST' && pathname === '/api/session') {
				const cookie = cookieId(req);
				const existing = hosted ? (cookie?.instance === instanceId ? runs.get(cookie.id) : undefined) : localRun;
				if (existing?.state === 'ending') throw endedError(req);
				const input = await body(req);
				if (existing?.state !== undefined && existing.state !== 'active') throw endedError(req);
				if (closed) throw new HttpError(503, 'Host is closed');
				if (!input || typeof input !== 'object' || !('preset' in input))
					throw new HttpError(400, 'Expected { preset }');
				try {
					validateBridgeRequest({ version: PROTOCOL_VERSION, id: 0, type: 'session.start', payload: input.preset });
				} catch (error) {
					throw new HttpError(400, errorText(error));
				}
				run = existing ?? createRun(res);
				run.lastActivity = Date.now();
				await queued(run, async () => {
					await stop(run);
					assertActive(run);
					const next = createChildSession({ ...childOptions, preset: input.preset as Preset });
					run.session = next;
					next.observe((event: SessionEvent) => {
						publish(run, 'session-event', event as unknown as JsonValue);
						if (event.type === 'error') publish(run, 'session-error', event as unknown as JsonValue);
						if (event.type === 'error' && event.origin === 'child') {
							if (run.session === next) run.session = undefined;
							publish(run, 'child-exit', event as unknown as JsonValue);
						}
					});
					try {
						await next.start();
						assertActive(run);
					} catch (error) {
						run.session = undefined;
						throw error;
					}
					publish(run, 'session-started', { preset: input.preset as JsonValue });
				});
				sendJson(res, 201, { ok: true });
				return;
			}
			if (req.method === 'DELETE' && pathname === '/api/session') {
				run = requireRun(req);
				if (hosted) {
					await endRun(run, 'stopped');
					res.setHeader(
						'set-cookie',
						`slipher_lab_run=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${publicOrigin?.protocol === 'https:' ? '; Secure' : ''}`,
					);
				} else await queued(run, () => stop(run));
				sendJson(res, 200, { ok: true });
				return;
			}
			if (req.method === 'POST' && pathname === '/api/rpc') {
				run = requireRun(req);
				const request = await body(req);
				try {
					validateBridgeRequest(request);
				} catch (error) {
					throw new HttpError(400, errorText(error));
				}
				if (
					request.type === 'session.start' ||
					request.type === 'session.dispose' ||
					request.type === 'project.describe'
				)
					throw new HttpError(400, `Use lifecycle endpoint for ${request.type}`);
				const result = await queued(run, async () => {
					if (!run.session) throw new HttpError(409, 'Session is not started');
					try {
						return bridgeResponse(request.id, true, await invoke(run.session, request));
					} catch (error) {
						return bridgeResponse(request.id, false, undefined, errorText(error));
					}
				});
				sendJson(res, 200, result);
				return;
			}
			if ((req.method === 'GET' || (hosted && req.method === 'HEAD')) && !pathname.startsWith('/api/')) {
				await staticFile(pathname, res, req.method === 'HEAD');
				return;
			}
			throw new HttpError(404, 'Route not found');
		})().catch(error => {
			if (res.headersSent) {
				res.end();
				return;
			}
			sendJson(res, error instanceof HttpError ? error.status : 500, {
				error: errorText(error),
				...(error instanceof HttpError ? error.detail : {}),
			});
			if (!(error instanceof HttpError)) publish(run ?? localRun, 'session-error', { error: errorText(error) });
		});
	});
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
	const url = `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`;
	return {
		url,
		async close() {
			if (closed) return;
			closed = true;
			if (reaper) clearInterval(reaper);
			let cleanupError: unknown;
			try {
				if (hosted) {
					await Promise.allSettled([...runs.values()].map(run => endRun(run, 'shutdown')));
					if (cleanupErrors.length) cleanupError = new AggregateError(cleanupErrors, 'Lab run cleanup failed');
				} else {
					for (const stream of localRun.streams) stream.end();
					await queued(localRun, () => stop(localRun));
				}
			} catch (error) {
				cleanupError = error;
			}
			await Promise.allSettled(describes);
			await new Promise<void>((done, reject) => server.close(error => (error ? reject(error) : done())));
			if (cleanupError) throw cleanupError;
		},
	};
}
