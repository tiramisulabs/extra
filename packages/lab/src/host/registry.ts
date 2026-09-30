import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { HostInfo, RunEndReason } from '../protocol';
import { errorText } from '../shared';
import { HttpError } from './http';
import { createRun, enqueue, enqueueTeardown, publish, type Run, stopSession } from './run';

export interface HostLimits {
	maxRuns: number;
	idleTtlMs: number;
	maxRunMs: number;
}

/** How requests map to runs: local mode has a single run, hosted mode one per browser cookie. */
export interface RunScope {
	readonly limits?: HostLimits;
	/** Local mode's only run, which also receives `session-error` events for failures outside any run. */
	readonly local?: Run;
	info(req: IncomingMessage): HostInfo['run'];
	/** The request's active run, marked as used; throws 409 when it is missing or has ended. */
	require(req: IncomingMessage): Run;
	/** The request's run in any state, which a session start reuses instead of creating a new run. */
	lookup(req: IncomingMessage): Run | undefined;
	create(res: ServerResponse): Run;
	stop(run: Run, res: ServerResponse): Promise<void>;
	close(): Promise<void>;
}

/** Local mode has one run that never ends; it also receives errors raised outside a route. */
export class LocalRuns implements RunScope {
	readonly local: Run;

	constructor(dataDir: string) {
		this.local = createRun('', dataDir);
	}

	info(): HostInfo['run'] {
		return { state: 'active', session: !!this.local.session };
	}
	require(): Run {
		return this.local;
	}
	lookup(): Run {
		return this.local;
	}
	create(): Run {
		return this.local;
	}
	stop(run: Run): Promise<void> {
		return enqueue(run, () => stopSession(run));
	}
	async close(): Promise<void> {
		const run = this.local;
		for (const stream of run.streams) stream.end();
		await enqueue(run, () => stopSession(run));
	}
}

const RUN_COOKIE = 'slipher_lab_run';
/** Recently ended run ids kept so their cookies still report why the run ended. */
const MAX_TOMBSTONES = 256;
const REAPER_MIN_INTERVAL_MS = 10;
const REAPER_MAX_INTERVAL_MS = 30_000;

interface RunCookie {
	instance: string;
	id: string;
}

/** Cookie value is `<instanceId>.<runId>`; a value without an instance never matches this host. */
function readRunCookie(req: IncomingMessage): RunCookie | undefined {
	const prefix = `${RUN_COOKIE}=`;
	const value = req.headers.cookie
		?.split(';')
		.map(part => part.trim())
		.find(part => part.startsWith(prefix))
		?.slice(prefix.length);
	if (!value) return undefined;
	const dot = value.indexOf('.');
	return dot > 0 ? { instance: value.slice(0, dot), id: value.slice(dot + 1) } : { instance: '', id: value };
}

function expiryReason(run: Run, limits: HostLimits, now: number): RunEndReason | undefined {
	if (now - run.startedAt >= limits.maxRunMs) return 'max-lifetime';
	if (now - run.lastActivity >= limits.idleTtlMs) return 'expired';
	return undefined;
}

export class HostedRuns implements RunScope {
	private readonly runs = new Map<string, Run>();
	private readonly tombstones = new Map<string, RunEndReason>();
	/** Failed run cleanups, including ones started by the reaper, reported again by `close`. */
	private readonly cleanupErrors: Error[] = [];
	private readonly reaper: NodeJS.Timeout;

	/** Checkpoints are scoped to a run, so directories left by a previous process are removed. */
	static async open(instanceId: string, dataDir: string, limits: HostLimits, secure: boolean): Promise<HostedRuns> {
		const runsDir = resolve(dataDir, 'runs');
		await rm(runsDir, { recursive: true, force: true });
		await mkdir(runsDir, { recursive: true });
		return new HostedRuns(instanceId, runsDir, limits, secure);
	}

	private constructor(
		private readonly instanceId: string,
		private readonly runsDir: string,
		readonly limits: HostLimits,
		private readonly secure: boolean,
	) {
		const interval = Math.min(limits.idleTtlMs, limits.maxRunMs) / 2;
		this.reaper = setInterval(
			() => this.reap(),
			Math.min(REAPER_MAX_INTERVAL_MS, Math.max(REAPER_MIN_INTERVAL_MS, interval)),
		);
		this.reaper.unref();
	}

	info(req: IncomingMessage): HostInfo['run'] {
		const run = this.find(req);
		if (run)
			return {
				state: 'active',
				session: !!run.session,
				startedAt: new Date(run.startedAt).toISOString(),
				idleExpiresAt: new Date(run.lastActivity + this.limits.idleTtlMs).toISOString(),
				expiresAt: new Date(run.startedAt + this.limits.maxRunMs).toISOString(),
			};
		const cookie = readRunCookie(req);
		if (!cookie) return { state: 'none' };
		const reason = this.endReason(cookie);
		return { state: 'ended', ...(reason ? { reason } : {}) };
	}

	require(req: IncomingMessage): Run {
		const run = this.find(req);
		if (run) {
			run.lastActivity = Date.now();
			return run;
		}
		const cookie = readRunCookie(req);
		if (!cookie) throw new HttpError(409, 'Run is missing', { code: 'run-missing' });
		const reason = this.endReason(cookie);
		throw new HttpError(409, 'Run has ended', { code: 'run-ended', ...(reason ? { reason } : {}) });
	}

	lookup(req: IncomingMessage): Run | undefined {
		const cookie = readRunCookie(req);
		return cookie?.instance === this.instanceId ? this.runs.get(cookie.id) : undefined;
	}

	create(res: ServerResponse): Run {
		if (this.runs.size >= this.limits.maxRuns) throw new HttpError(429, 'Run limit reached', { code: 'run-limit' });
		const id = randomBytes(32).toString('base64url');
		const run = createRun(id, resolve(this.runsDir, id));
		this.runs.set(id, run);
		res.setHeader('set-cookie', this.cookie(`${this.instanceId}.${id}`));
		return run;
	}

	async stop(run: Run, res: ServerResponse): Promise<void> {
		await this.end(run, 'stopped');
		res.setHeader('set-cookie', this.cookie('', '; Max-Age=0'));
	}

	async close(): Promise<void> {
		clearInterval(this.reaper);
		await Promise.allSettled([...this.runs.values()].map(run => this.end(run, 'shutdown')));
		if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, 'Lab run cleanup failed');
	}

	private cookie(value: string, attributes = ''): string {
		return `${RUN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${attributes}${this.secure ? '; Secure' : ''}`;
	}

	private find(req: IncomingMessage): Run | undefined {
		const run = this.lookup(req);
		return run?.state === 'active' ? run : undefined;
	}

	private endReason(cookie: RunCookie): RunEndReason | undefined {
		if (cookie.instance !== this.instanceId) return 'restarted';
		return this.runs.get(cookie.id)?.endReason ?? this.tombstones.get(cookie.id);
	}

	private reap(): void {
		const now = Date.now();
		for (const run of this.runs.values()) {
			if (run.state !== 'active' || run.pending > 0) continue;
			const reason = expiryReason(run, this.limits, now);
			// A failure is recorded in cleanupErrors and reported by close().
			if (reason) void this.end(run, reason).catch(() => undefined);
		}
	}

	/** Ends the run once: waits for queued work, disposes the session, closes streams and deletes checkpoints. */
	private end(run: Run, reason: RunEndReason): Promise<void> {
		if (run.endTask) return run.endTask;
		run.state = 'ending';
		run.endReason = reason;
		run.endTask = this.release(run, reason).finally(() => {
			run.state = 'ended';
			this.runs.delete(run.id);
			this.tombstones.set(run.id, reason);
			if (this.tombstones.size > MAX_TOMBSTONES) {
				const [oldest] = this.tombstones.keys();
				this.tombstones.delete(oldest);
			}
		});
		return run.endTask;
	}

	private async release(run: Run, reason: RunEndReason): Promise<void> {
		const failures: unknown[] = [];
		await enqueueTeardown(run, () => stopSession(run)).catch(error => failures.push(error));
		publish(run, 'session-stopped', { reason });
		for (const stream of run.streams) stream.end();
		await rm(run.checkpointsDir, { recursive: true, force: true }).catch(error => failures.push(error));
		if (!failures.length) return;
		const error = new AggregateError(failures, `Run ${run.id} cleanup failed`);
		this.cleanupErrors.push(error);
		process.stderr.write(`Lab run ${run.id} cleanup failed: ${failures.map(errorText).join('; ')}\n`);
		throw error;
	}
}
