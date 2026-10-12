import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonValue, Session } from '../index';
import type { RunEndReason } from '../protocol';
import { HttpError } from './http';

/** Events kept for `Last-Event-ID` reconnects. */
const EVENT_HISTORY = 256;
const HEARTBEAT_MS = 15_000;

interface RunEvent {
	id: number;
	type: string;
	data: JsonValue;
}

/** One browser's lab: its session, serialized operation queue, event stream and checkpoint directory. */
export interface Run {
	id: string;
	state: 'active' | 'ending' | 'ended';
	endReason?: RunEndReason;
	endTask?: Promise<void>;
	session?: Session;
	/** Tail of the operation queue; always settles so later operations still run. */
	serial: Promise<void>;
	pending: number;
	eventId: number;
	history: RunEvent[];
	streams: Set<ServerResponse>;
	checkpointsDir: string;
	startedAt: number;
	lastActivity: number;
}

export function createRun(id: string, checkpointsDir: string): Run {
	const now = Date.now();
	return {
		id,
		state: 'active',
		serial: Promise.resolve(),
		pending: 0,
		eventId: 0,
		history: [],
		streams: new Set(),
		checkpointsDir,
		startedAt: now,
		lastActivity: now,
	};
}

export function assertActive(run: Run): void {
	if (run.state !== 'active')
		throw new HttpError(409, 'Run has ended', {
			code: 'run-ended',
			...(run.endReason ? { reason: run.endReason } : {}),
		});
}

function settled(promise: Promise<unknown>): Promise<void> {
	return promise.then(
		() => undefined,
		() => undefined,
	);
}

/** Runs `task` after every earlier operation on the run, and only while the run is active. */
export function enqueue<T>(run: Run, task: () => Promise<T>): Promise<T> {
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
	run.serial = settled(result);
	return result;
}

/** Queues `task` regardless of run state; used by teardown, which must run after in-flight operations. */
export function enqueueTeardown(run: Run, task: () => Promise<void>): Promise<void> {
	const result = run.serial.then(task);
	run.serial = settled(result);
	return result;
}

export async function stopSession(run: Run): Promise<void> {
	const previous = run.session;
	run.session = undefined;
	if (previous) await previous.dispose();
}

function sseFrame(event: RunEvent): string {
	return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function publish(run: Run, type: string, data: JsonValue): void {
	const event = { id: ++run.eventId, type, data };
	run.history.push(event);
	if (run.history.length > EVENT_HISTORY) run.history.shift();
	for (const stream of run.streams) stream.write(sseFrame(event));
}

/** Opens an SSE stream, replaying history newer than `Last-Event-ID` (all of it when the header is absent). */
export function openEventStream(run: Run, req: IncomingMessage, res: ServerResponse): void {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
	});
	res.write(': connected\n\n');
	const lastId = Number(req.headers['last-event-id'] ?? 0);
	if (Number.isSafeInteger(lastId) && lastId >= 0)
		for (const event of run.history) if (event.id > lastId) res.write(sseFrame(event));
	run.streams.add(res);
	const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
	res.on('close', () => {
		clearInterval(heartbeat);
		run.streams.delete(res);
	});
}
