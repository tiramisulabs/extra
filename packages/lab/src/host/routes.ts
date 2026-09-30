import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { invokeSession } from '../bridge';
import { type ChildSessionOptions, createChildSession } from '../child';
import type { Checkpoint, Preset, Session, SessionEvent } from '../index';
import {
	type BridgeResponse,
	type HostInfo,
	PROTOCOL_VERSION,
	type ProjectDescription,
	validateBridgeRequest,
	validateCheckpoint,
	validateCheckpointName,
	validatePreset,
} from '../protocol';
import { replaySession } from '../runtime';
import { exportTest } from '../runtime/checkpoint';
import { errorText, LAB_VERSION } from '../shared';
import { listCheckpoints, readCheckpoint, writeCheckpoint } from './checkpoints';
import { isLocalRequest, isPublicOriginRequest } from './guards';
import { HttpError, isRecord, readJsonBody, sendJson, validated } from './http';
import type { HostAccess, HostOptions } from './index';
import type { RunScope } from './registry';
import { assertActive, enqueue, openEventStream, publish, type Run, stopSession } from './run';
import { serveUi } from './static';

const CHECKPOINT_PREFIX = '/api/checkpoints/';
const HOSTED_EXPORT_MODULE = './lab/project';
/** Bridge requests with a dedicated endpoint, so `/api/rpc` cannot bypass run bookkeeping. */
const LIFECYCLE_REQUESTS = new Set(['session.start', 'session.dispose', 'project.describe']);

/** Everything request handlers need from a started host. */
export interface HostContext {
	options: HostOptions;
	hosted?: { publicOrigin: URL; access: HostAccess };
	instanceId: string;
	uiRoot?: string;
	runs: RunScope;
	childOptions: Omit<ChildSessionOptions, 'preset'>;
	describeProject(): Promise<ProjectDescription>;
	isClosed(): boolean;
}

interface Exchange {
	req: IncomingMessage;
	res: ServerResponse;
	/** The run the request operates on, which receives `session-error` if the request fails unexpectedly. */
	run?: Run;
}

type Route = (host: HostContext, exchange: Exchange, url: URL) => Promise<void>;

export function createRequestListener(host: HostContext): RequestListener {
	return (req, res) => {
		const exchange: Exchange = { req, res };
		handle(host, exchange).catch(error => sendError(host, exchange, error));
	};
}

async function handle(host: HostContext, exchange: Exchange): Promise<void> {
	const { req, res } = exchange;
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (host.hosted) {
		res.setHeader('x-frame-options', 'DENY');
		res.setHeader('referrer-policy', 'no-referrer');
		// Health checks come from the platform, not through the public origin.
		if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
		if (!isPublicOriginRequest(req, host.hosted.publicOrigin, url.pathname))
			throw new HttpError(403, 'Host or Origin is not permitted');
		if (host.hosted.access.mode === 'authorize' && !(await host.hosted.access.authorize(req)))
			throw new HttpError(401, 'Unauthorized');
	} else if (!isLocalRequest(req)) throw new HttpError(403, 'Host and Origin must be local');
	if (host.isClosed()) throw new HttpError(503, 'Host is closed');
	const route =
		routes[`${req.method} ${url.pathname}`] ??
		(url.pathname.startsWith(CHECKPOINT_PREFIX) ? checkpointRoute : undefined);
	if (route) return route(host, exchange, url);
	if ((req.method === 'GET' || (host.hosted && req.method === 'HEAD')) && !url.pathname.startsWith('/api/'))
		return serveUi(host.uiRoot, url.pathname, res, req.method === 'HEAD');
	throw new HttpError(404, 'Route not found');
}

function sendError(host: HostContext, { res, run }: Exchange, error: unknown): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	if (error instanceof HttpError) {
		sendJson(res, error.status, { error: error.message, ...error.detail });
		return;
	}
	sendJson(res, 500, { error: errorText(error) });
	const target = run ?? host.runs.fallback;
	if (target) publish(target, 'session-error', { detail: errorText(error) });
}

function requireRun(host: HostContext, exchange: Exchange): Run {
	exchange.run = host.runs.require(exchange.req);
	return exchange.run;
}

const routes: Record<string, Route> = {
	'GET /api/host': hostInfo,
	'GET /api/events': events,
	'GET /api/describe': describe,
	'GET /api/checkpoints': checkpointNames,
	'POST /api/checkpoints': saveCheckpoint,
	'POST /api/session': startSession,
	'DELETE /api/session': endSession,
	'POST /api/rpc': rpc,
};

async function hostInfo(host: HostContext, { req, res }: Exchange): Promise<void> {
	const { build } = host.options;
	const limits = host.runs.limits;
	const info: HostInfo = {
		mode: host.hosted ? 'hosted' : 'local',
		instanceId: host.instanceId,
		labVersion: LAB_VERSION,
		protocolVersion: PROTOCOL_VERSION,
		...(build ? { build } : {}),
		...(limits ? { limits } : {}),
		run: host.runs.info(req),
	};
	sendJson(res, 200, info);
}

async function events(host: HostContext, exchange: Exchange): Promise<void> {
	openEventStream(requireRun(host, exchange), exchange.req, exchange.res);
}

async function describe(host: HostContext, { res }: Exchange): Promise<void> {
	sendJson(res, 200, await host.describeProject());
}

async function startSession(host: HostContext, exchange: Exchange): Promise<void> {
	const { req, res } = exchange;
	const existing = host.runs.lookup(req);
	if (existing) assertActive(existing);
	const input = await readJsonBody(req);
	// The run may have ended while the body was arriving.
	if (existing) assertActive(existing);
	if (host.isClosed()) throw new HttpError(503, 'Host is closed');
	if (!isRecord(input) || !('preset' in input)) throw new HttpError(400, 'Expected { preset }');
	const preset = validatedPreset(input.preset);
	const run = existing ?? host.runs.create(res);
	exchange.run = run;
	await enqueue(run, () => startRunSession(host, run, preset));
	sendJson(res, 201, { ok: true });
}

function validatedPreset(value: unknown): Preset {
	return validated(() => {
		validatePreset(value);
		return value;
	});
}

async function startRunSession(host: HostContext, run: Run, preset: Preset): Promise<void> {
	await stopSession(run);
	assertActive(run);
	const session = createChildSession({ ...host.childOptions, preset });
	run.session = session;
	session.observe(event => forwardSessionEvent(run, session, event));
	try {
		await session.start();
		assertActive(run);
	} catch (error) {
		run.session = undefined;
		throw error;
	}
	publish(run, 'session-started', { preset });
}

function forwardSessionEvent(run: Run, session: Session, event: SessionEvent): void {
	publish(run, 'session-event', event);
	if (event.type !== 'error') return;
	publish(run, 'session-error', event);
	if (event.origin !== 'child') return;
	if (run.session === session) run.session = undefined;
	// The process may still be alive after a protocol or IPC error.
	session.dispose().catch(() => undefined);
	publish(run, 'child-exit', event);
}

async function endSession(host: HostContext, exchange: Exchange): Promise<void> {
	await host.runs.stop(requireRun(host, exchange), exchange.res);
	sendJson(exchange.res, 200, { ok: true });
}

async function rpc(host: HostContext, exchange: Exchange): Promise<void> {
	const run = requireRun(host, exchange);
	const body = await readJsonBody(exchange.req);
	const request = validated(() => {
		validateBridgeRequest(body);
		return body;
	});
	if (LIFECYCLE_REQUESTS.has(request.type)) throw new HttpError(400, `Use lifecycle endpoint for ${request.type}`);
	const response = await enqueue(run, async (): Promise<BridgeResponse> => {
		if (!run.session) throw new HttpError(409, 'Session is not started');
		const result = { version: PROTOCOL_VERSION, id: request.id, type: 'result' } as const;
		try {
			return { ...result, ok: true, value: (await invokeSession(run.session, request)) ?? null };
		} catch (error) {
			return { ...result, ok: false, error: errorText(error) };
		}
	});
	sendJson(exchange.res, 200, response);
}

async function checkpointNames(host: HostContext, exchange: Exchange): Promise<void> {
	const run = requireRun(host, exchange);
	sendJson(exchange.res, 200, { names: await listCheckpoints(run.checkpointsDir) });
}

async function saveCheckpoint(host: HostContext, exchange: Exchange): Promise<void> {
	const run = requireRun(host, exchange);
	const input = await readJsonBody(exchange.req);
	if (!isRecord(input) || !('checkpoint' in input)) throw new HttpError(400, 'Expected { checkpoint }');
	const draft = { ...(isRecord(input.checkpoint) ? input.checkpoint : {}) };
	// A hosted checkpoint must not reveal the server's filesystem layout.
	if (host.hosted) delete draft.projectModule;
	else draft.projectModule = host.options.projectModule;
	if (host.options.build && draft.build === undefined) draft.build = { revision: host.options.build.revision };
	const checkpoint = await validatedCheckpoint(host, draft);
	assertRevision(host, checkpoint, input);
	await enqueue(run, () => writeCheckpoint(run.checkpointsDir, checkpoint, () => assertActive(run)));
	sendJson(exchange.res, 201, { name: checkpoint.name });
}

/** Routes under `/api/checkpoints/<name>`: load, `/replay` and `/export`. */
async function checkpointRoute(host: HostContext, exchange: Exchange, url: URL): Promise<void> {
	const { req, res } = exchange;
	const run = requireRun(host, exchange);
	const rest = url.pathname.slice(CHECKPOINT_PREFIX.length);
	const slash = rest.indexOf('/');
	const suffix = slash < 0 ? '' : rest.slice(slash);
	let name: string;
	try {
		name = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash));
	} catch {
		throw new HttpError(400, 'Invalid checkpoint name');
	}
	validated(() => validateCheckpointName(name));
	switch (`${req.method}${suffix}`) {
		case 'GET':
			return sendJson(res, 200, await loadCheckpoint(host, run, name));
		case 'POST/replay':
			return replayCheckpoint(host, exchange, run, name);
		case 'GET/export':
			return sendJson(res, 200, { code: await exportCheckpoint(host, run, name, url.searchParams.get('format')) });
		default:
			throw new HttpError(404, 'Route not found');
	}
}

async function replayCheckpoint(host: HostContext, { req, res }: Exchange, run: Run, name: string): Promise<void> {
	const input = await readJsonBody(req, true);
	const checkpoint = await loadCheckpoint(host, run, name);
	assertRevision(host, checkpoint, input);
	const result = await enqueue(run, async () => {
		if (run.session) {
			await stopSession(run);
			publish(run, 'session-stopped', { reason: 'replay' });
		}
		assertActive(run);
		return replaySession(createChildSession({ ...host.childOptions, preset: checkpoint.preset }), checkpoint);
	});
	sendJson(res, 200, { ok: true, log: result.log, inspect: result.inspect });
}

async function exportCheckpoint(host: HostContext, run: Run, name: string, format: string | null): Promise<string> {
	if (format !== 'node' && format !== 'vitest') throw new HttpError(400, 'Export format must be node or vitest');
	const { exportModule, projectModule } = host.options;
	const code = exportTest(await loadCheckpoint(host, run, name), {
		format,
		projectModule: exportModule ?? (host.hosted ? HOSTED_EXPORT_MODULE : projectModule),
	});
	return host.hosted && !exportModule
		? `// Point this path at the project module before running this test.\n${code}`
		: code;
}

async function loadCheckpoint(host: HostContext, run: Run, name: string): Promise<Checkpoint> {
	return validatedCheckpoint(host, await readCheckpoint(run.checkpointsDir, name));
}

async function validatedCheckpoint(host: HostContext, value: unknown): Promise<Checkpoint> {
	try {
		validateCheckpoint(value, await host.describeProject());
		if (value.labVersion !== LAB_VERSION)
			throw new Error(`Checkpoint lab version ${value.labVersion} is not supported (current ${LAB_VERSION})`);
		return value;
	} catch (error) {
		throw new HttpError(400, errorText(error));
	}
}

/** A checkpoint recorded on another build replays only when the request sets `acceptRevision: true`. */
function assertRevision(host: HostContext, checkpoint: Checkpoint, input: unknown): void {
	const { build } = host.options;
	if (!build || !checkpoint.build || checkpoint.build.revision === build.revision) return;
	if (isRecord(input) && input.acceptRevision === true) return;
	throw new HttpError(409, 'Checkpoint revision differs from this build', {
		code: 'revision-mismatch',
		checkpointRevision: checkpoint.build.revision,
		currentRevision: build.revision,
	});
}
