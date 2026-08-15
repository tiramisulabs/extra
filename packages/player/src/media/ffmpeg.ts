import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { kill, platform } from 'node:process';
import { demuxOggOpus, type VoicePlaybackSource } from '@slipher/voice';
import { PlayerError } from '../errors';
import type { MediaResource } from '../types';
import { forwardAbort, type MediaBackendOpenOptions, type MediaSource, readNodeByteStream } from './source';

const STDERR_TAIL_BYTES = 16 * 1_024;
const TERMINATION_GRACE_MS = 5_000;
const IS_WINDOWS = platform === 'win32';

export async function openFfmpegMediaSource(
	source: MediaSource,
	options: MediaBackendOpenOptions,
	ffmpegPath: string,
): Promise<MediaResource> {
	options.signal.throwIfAborted();
	const controller = new AbortController();
	const detachAbort = forwardAbort(options.signal, controller);
	const child = spawn(ffmpegPath, buildFfmpegArguments(source, options.startAtMs), {
		detached: !IS_WINDOWS,
		shell: false,
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	const outcomePromise = waitForProcess(child);
	const stderrPromise = collectStderrTail(child.stderr);
	let processClosePromise: Promise<void> | undefined;
	const beginProcessClose = () => {
		processClosePromise ??= closeFfmpegProcess(child, outcomePromise);
	};
	controller.signal.addEventListener('abort', beginProcessClose, { once: true });
	if (controller.signal.aborted) beginProcessClose();

	try {
		await waitForSpawn(child);
	} catch (cause) {
		controller.abort();
		const outcome = await outcomePromise;
		const stderr = await stderrPromise;
		detachAbort();
		controller.signal.removeEventListener('abort', beginProcessClose);
		throw createFfmpegError(outcome, stderr, ffmpegPath, cause);
	}

	const inputPromise = writeProcessInput(child, source.kind === 'bytes' ? source.data : undefined);
	void inputPromise.catch(() => undefined);
	let consumed = false;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const close = () => {
		if (closePromise) return closePromise;
		closing = true;
		controller.abort();
		detachAbort();
		beginProcessClose();
		closePromise = processClosePromise!
			.then(() => Promise.allSettled([inputPromise, stderrPromise]))
			.then(() => undefined)
			.finally(() => {
				controller.signal.removeEventListener('abort', beginProcessClose);
			});
		return closePromise;
	};
	const packets: VoicePlaybackSource = {
		async *[Symbol.asyncIterator]() {
			if (consumed) throw new TypeError('A media resource can only be consumed once.');
			consumed = true;
			try {
				yield* demuxOggOpus(readNodeByteStream(child.stdout));
				const outcome = await outcomePromise;
				await inputPromise;
				if (outcome.error || outcome.code !== 0) {
					throw createFfmpegError(outcome, await stderrPromise, ffmpegPath);
				}
			} catch (error) {
				controller.abort();
				const outcome = await outcomePromise;
				const stderr = await stderrPromise;
				if (options.signal.aborted) throw options.signal.reason;
				if (closing) return;
				if (PlayerError.is(error, 'PLAYER_MEDIA_FAILED')) throw error;
				throw createFfmpegError(outcome, stderr, ffmpegPath, error);
			} finally {
				await close();
			}
		},
	};
	return Object.freeze({ packets, close });
}

/** @internal */
export function buildFfmpegArguments(source: MediaSource, startAtMs?: number): string[] {
	const inputOptions: string[] = [];
	if (startAtMs !== undefined && startAtMs > 0) inputOptions.push('-ss', String(startAtMs / 1_000));
	if (source.kind === 'remote') {
		inputOptions.push('-protocol_whitelist', 'http,https,tcp,tls,crypto');
		if (source.timeline.kind === 'live') {
			inputOptions.push(
				'-reconnect',
				'1',
				'-reconnect_streamed',
				'1',
				'-reconnect_on_network_error',
				'1',
				'-reconnect_on_http_error',
				'429,5xx',
				'-reconnect_delay_max',
				'5',
				'-reconnect_delay_total_max',
				'30',
			);
		}
	} else {
		inputOptions.push('-protocol_whitelist', source.kind === 'bytes' ? 'pipe' : 'file,pipe');
	}

	const input = source.kind === 'file' ? source.path : source.kind === 'remote' ? source.url : 'pipe:0';
	return [
		'-nostdin',
		'-hide_banner',
		'-loglevel',
		'error',
		...inputOptions,
		'-i',
		input,
		'-map',
		'0:a:0',
		'-vn',
		'-sn',
		'-dn',
		'-ar',
		'48000',
		'-ac',
		'2',
		'-c:a',
		'libopus',
		'-application',
		'audio',
		'-frame_duration',
		'20',
		'-mapping_family',
		'0',
		'-f',
		'ogg',
		'-page_duration',
		'20000',
		'-flush_packets',
		'1',
		'pipe:1',
	];
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve, reject) => {
		const spawned = () => {
			child.removeListener('error', failed);
			resolve();
		};
		const failed = (error: Error) => {
			child.removeListener('spawn', spawned);
			reject(error);
		};
		child.once('spawn', spawned);
		child.once('error', failed);
	});
}

function waitForProcess(child: ChildProcessWithoutNullStreams): Promise<ProcessOutcome> {
	return new Promise(resolve => {
		let settled = false;
		const settle = (outcome: ProcessOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};
		child.once('error', error => settle({ code: null, signal: null, error }));
		child.once('close', (code, signal) => settle({ code, signal }));
	});
}

function writeProcessInput(child: ChildProcessWithoutNullStreams, data?: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		const failed = (error: Error) => {
			child.stdin.removeListener('finish', finished);
			reject(error);
		};
		const finished = () => {
			child.stdin.removeListener('error', failed);
			resolve();
		};
		child.stdin.once('error', failed);
		child.stdin.once('finish', finished);
		child.stdin.end(data);
	});
}

async function collectStderrTail(stream: NodeJS.ReadableStream): Promise<string> {
	let tail: Uint8Array<ArrayBufferLike> = new Uint8Array();
	try {
		for await (const value of stream) {
			if (!(value instanceof Uint8Array)) continue;
			tail = appendTail(tail, value, STDERR_TAIL_BYTES);
		}
	} catch {
		// A canceled resource can destroy stderr before the child closes.
	}
	return new TextDecoder().decode(tail).trim();
}

function appendTail(
	current: Uint8Array<ArrayBufferLike>,
	next: Uint8Array<ArrayBufferLike>,
	maximum: number,
): Uint8Array<ArrayBufferLike> {
	if (next.byteLength >= maximum) return next.slice(next.byteLength - maximum);
	const retained = Math.min(current.byteLength, maximum - next.byteLength);
	const output = new Uint8Array(retained + next.byteLength);
	output.set(current.subarray(current.byteLength - retained));
	output.set(next, retained);
	return output;
}

function signalChildProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	try {
		child.kill(signal);
	} catch {
		// The process may have exited between the state check and the signal.
	}
}

function signalPosixProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid === undefined) {
		signalChildProcess(child, signal);
		return;
	}
	try {
		// FFmpeg is spawned detached on POSIX, so its PID is a private process-group ID, never the runner's group.
		kill(-pid, signal);
	} catch {
		// Fall back for a compatible runtime that spawned the child but could not signal its process group.
		signalChildProcess(child, signal);
	}
}

function posixProcessTreeExists(child: ChildProcessWithoutNullStreams): boolean {
	const pid = child.pid;
	if (pid === undefined) return false;
	try {
		kill(-pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && 'code' in error && error.code !== 'ESRCH';
	}
}

async function forceWindowsProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
	const pid = child.pid;
	if (pid === undefined) {
		signalChildProcess(child, 'SIGKILL');
		return;
	}
	const killed = await new Promise<boolean>(resolve => {
		const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
			shell: false,
			stdio: 'ignore',
			windowsHide: true,
		});
		let settled = false;
		const settle = (succeeded: boolean) => {
			if (settled) return;
			settled = true;
			resolve(succeeded);
		};
		taskkill.once('error', () => settle(false));
		taskkill.once('close', code => settle(code === 0));
	});
	if (!killed) signalChildProcess(child, 'SIGKILL');
}

async function closeFfmpegProcess(
	child: ChildProcessWithoutNullStreams,
	outcomePromise: Promise<ProcessOutcome>,
): Promise<void> {
	let escalation: ReturnType<typeof setTimeout> | undefined;
	let escalationPromise: Promise<void> | undefined;
	if (IS_WINDOWS) {
		// Windows cannot signal process groups; taskkill is immediate so it can still address the live parent and its tree.
		await forceWindowsProcessTree(child);
	} else {
		signalPosixProcessTree(child, 'SIGTERM');
		const escalated = Promise.withResolvers<void>();
		escalationPromise = escalated.promise;
		escalation = setTimeout(() => {
			signalPosixProcessTree(child, 'SIGKILL');
			escalated.resolve();
		}, TERMINATION_GRACE_MS);
		escalation.unref?.();
	}
	try {
		await outcomePromise;
		if (escalationPromise && posixProcessTreeExists(child)) await escalationPromise;
	} finally {
		if (escalation) clearTimeout(escalation);
		child.stdin.destroy();
		child.stdout.destroy();
	}
}

function createFfmpegError(outcome: ProcessOutcome, stderr: string, ffmpegPath: string, cause?: unknown): PlayerError {
	return new PlayerError('PLAYER_MEDIA_FAILED', {
		cause: cause ?? outcome.error,
		metadata: {
			detail: outcome.error ? 'FFmpeg could not be started.' : 'FFmpeg failed to produce playable Opus audio.',
			exitCode: outcome.code,
			signal: outcome.signal,
			stderr,
			ffmpegPath,
		},
	});
}

interface ProcessOutcome {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
}
