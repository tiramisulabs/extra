import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { PlayerError } from '../src/errors';
import { createMediaBackend } from '../src/media/backend';

const FFMPEG_AVAILABLE = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const encoder = new TextEncoder();
let fixtureDirectory: string;
let fakeFfmpegPath: string;
let stubbornFfmpegPath: string;
let wrapperTerminationMarkerPath: string;
let grandchildTerminationMarkerPath: string;
let wrapperPidPath: string;
let grandchildPidPath: string;

beforeAll(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), 'slipher-player-ffmpeg-'));
	fakeFfmpegPath = join(fixtureDirectory, 'fake-ffmpeg.mjs');
	stubbornFfmpegPath = join(fixtureDirectory, 'stubborn-ffmpeg.mjs');
	wrapperTerminationMarkerPath = join(fixtureDirectory, 'wrapper-sigterm-received');
	grandchildTerminationMarkerPath = join(fixtureDirectory, 'grandchild-sigterm-received');
	wrapperPidPath = join(fixtureDirectory, 'wrapper-pid');
	grandchildPidPath = join(fixtureDirectory, 'grandchild-pid');
	await writeFile(
		fakeFfmpegPath,
		`#!/usr/bin/env node
if (process.argv.includes('-reconnect')) {
	setInterval(() => undefined, 1_000);
} else {
	process.stderr.write('x'.repeat(20_000) + 'stderr-tail-marker');
	process.exitCode = 7;
}
`,
	);
	await chmod(fakeFfmpegPath, 0o755);
	const grandchildSource = `
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => writeFileSync(${JSON.stringify(grandchildTerminationMarkerPath)}, 'received'));
writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));
process.stdout.write(Buffer.alloc(27));
setInterval(() => undefined, 1_000);
`;
	await writeFile(
		stubbornFfmpegPath,
		`#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {
	writeFileSync(${JSON.stringify(wrapperTerminationMarkerPath)}, 'received');
	process.exit(0);
});
writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.pid));
spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
	stdio: ['ignore', 'inherit', 'inherit'],
});
setInterval(() => undefined, 1_000);
`,
	);
	await chmod(stubbornFfmpegPath, 0o755);
});

afterAll(async () => {
	await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('FFmpeg media backend', () => {
	test.skipIf(!FFMPEG_AVAILABLE)('transcodes in-memory PCM into Discord-compatible Opus packets', async () => {
		const backend = createMediaBackend();
		const resource = await backend.open(
			{
				kind: 'bytes',
				data: createWav(),
				format: 'unknown',
				timeline: { kind: 'finite', durationMs: 100, seekable: false },
			},
			{ signal: new AbortController().signal },
		);

		const packets = await collect(resource.packets);
		expect(packets.length).toBeGreaterThan(0);
		expect(packets.every(packet => packet.byteLength > 0)).toBe(true);
		await backend.close();
	});

	test('reports a missing FFmpeg executable as a media failure', async () => {
		const backend = createMediaBackend({ ffmpegPath: join(fixtureDirectory, 'missing-ffmpeg') });
		await expect(
			backend.open(
				{
					kind: 'bytes',
					data: createWav(),
					format: 'unknown',
					timeline: { kind: 'finite', durationMs: 100, seekable: false },
				},
				{ signal: new AbortController().signal },
			),
		).rejects.toMatchObject({
			code: 'PLAYER_MEDIA_FAILED',
			metadata: {
				detail: 'FFmpeg could not be started.',
				ffmpegPath: join(fixtureDirectory, 'missing-ffmpeg'),
			},
		});
		await backend.close();
	});

	test('bounds diagnostic stderr from a failed FFmpeg process', async () => {
		const backend = createMediaBackend({ ffmpegPath: fakeFfmpegPath });
		const resource = await backend.open(
			{
				kind: 'bytes',
				data: createWav(),
				format: 'unknown',
				timeline: { kind: 'finite', durationMs: 100, seekable: false },
			},
			{ signal: new AbortController().signal },
		);
		const error = await captureRejection(collect(resource.packets));
		expect(PlayerError.is(error, 'PLAYER_MEDIA_FAILED')).toBe(true);
		if (!PlayerError.is(error, 'PLAYER_MEDIA_FAILED')) throw error;
		const stderr = error.metadata?.stderr;
		expect(typeof stderr).toBe('string');
		expect(encoder.encode(stderr as string).byteLength).toBeLessThanOrEqual(16 * 1_024);
		expect(stderr).toMatch(/stderr-tail-marker$/u);
		await backend.close();
	});

	test('cancels a running FFmpeg process and closes idempotently', async () => {
		const backend = createMediaBackend({ ffmpegPath: fakeFfmpegPath });
		const controller = new AbortController();
		const resource = await backend.open(
			{
				kind: 'remote',
				url: 'https://example.com/live',
				format: 'unknown',
				timeline: { kind: 'live' },
			},
			{ signal: controller.signal },
		);
		const pending = collect(resource.packets);
		const reason = new Error('test cancellation');
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
		await expect(Promise.all([resource.close(), resource.close(), backend.close()])).resolves.toBeDefined();
	});

	test.skipIf(process.platform === 'win32')(
		'escalates termination for a stubborn FFmpeg process tree with inherited pipes',
		async () => {
			vi.useFakeTimers({ toFake: ['setTimeout'] });
			let wrapperPid: number | undefined;
			let grandchildPid: number | undefined;
			let treeClosed = false;
			try {
				const backend = createMediaBackend({ ffmpegPath: stubbornFfmpegPath });
				const resource = await backend.open(
					{
						kind: 'bytes',
						data: createWav(),
						format: 'unknown',
						timeline: { kind: 'finite', durationMs: 100, seekable: false },
					},
					{ signal: new AbortController().signal },
				);
				const pending = collect(resource.packets);
				await Promise.all([waitForFile(wrapperPidPath), waitForFile(grandchildPidPath)]);
				wrapperPid = Number(await readFile(wrapperPidPath, 'utf8'));
				grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
				await Promise.all([waitForFile(wrapperTerminationMarkerPath), waitForFile(grandchildTerminationMarkerPath)]);
				await vi.advanceTimersByTimeAsync(5_000);

				await expect(waitForSettlement(pending)).rejects.toMatchObject({ code: 'PLAYER_MEDIA_FAILED' });
				expect(processIsAlive(wrapperPid)).toBe(false);
				expect(processIsAlive(grandchildPid)).toBe(false);
				treeClosed = true;
				await backend.close();
			} finally {
				if (!treeClosed) {
					for (const pid of [grandchildPid, wrapperPid]) {
						if (pid === undefined) continue;
						try {
							process.kill(pid, 'SIGKILL');
						} catch {
							// The failed assertion may still have followed successful process cleanup.
						}
					}
				}
				vi.useRealTimers();
			}
		},
	);
});

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
	const values: Uint8Array[] = [];
	for await (const value of source) values.push(value);
	return values;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected the promise to reject.');
}

async function waitForFile(path: string): Promise<void> {
	const deadline = performance.now() + 2_000;
	while (performance.now() < deadline) {
		try {
			await readFile(path);
			return;
		} catch {
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}
	throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForSettlement<T>(promise: Promise<T>): Promise<T> {
	const outcomePromise = promise.then(
		value => ({ status: 'fulfilled', value }) as const,
		reason => ({ status: 'rejected', reason }) as const,
	);
	let settled = false;
	void outcomePromise.then(() => {
		settled = true;
	});
	const deadline = performance.now() + 2_000;
	while (!settled && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
	if (!settled) throw new Error('Timed out waiting for the FFmpeg process tree to close.');
	const outcome = await outcomePromise;
	if (outcome.status === 'rejected') throw outcome.reason;
	return outcome.value;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function createWav(): Uint8Array {
	const sampleRate = 48_000;
	const samples = sampleRate / 10;
	const bytesPerSample = 2;
	const dataSize = samples * bytesPerSample;
	const output = new Uint8Array(44 + dataSize);
	const view = new DataView(output.buffer);
	output.set(encoder.encode('RIFF'));
	view.setUint32(4, 36 + dataSize, true);
	output.set(encoder.encode('WAVEfmt '), 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	output.set(encoder.encode('data'), 36);
	view.setUint32(40, dataSize, true);
	for (let sample = 0; sample < samples; sample++) {
		const value = Math.round(Math.sin((sample * Math.PI * 2 * 440) / sampleRate) * 8_000);
		view.setInt16(44 + sample * bytesPerSample, value, true);
	}
	return output;
}
