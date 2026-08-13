import { afterEach, describe, expect, test, vi } from 'vitest';
import { OPUS_SILENCE_FRAME } from '../src/media/opus';
import { VoiceAudioTransmission } from '../src/media/transmission';

function createOutput() {
	const frames: Array<{ readonly frame: Uint8Array; readonly samples: number; readonly at: number }> = [];
	const speaking: Array<{ readonly value: boolean; readonly at: number }> = [];
	const advanced: number[] = [];
	return {
		advanced,
		frames,
		speaking,
		output: {
			now: () => Date.now(),
			setSpeaking(value: boolean) {
				speaking.push({ value, at: Date.now() });
			},
			async sendFrame(frame: Uint8Array, samples: number) {
				frames.push({ frame: frame.slice(), samples, at: Date.now() });
			},
			advanceTimestamp(samples: number) {
				advanced.push(samples);
			},
		},
	};
}

async function flushWork(iterations = 8): Promise<void> {
	for (let index = 0; index < iterations; index++) await Promise.resolve();
}

describe('VoiceAudioTransmission', () => {
	afterEach(() => vi.useRealTimers());

	test('paces packets and completes with five silence frames before disabling speaking', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = createOutput();
		const source = {
			async *[Symbol.asyncIterator]() {
				yield OPUS_SILENCE_FRAME;
				yield OPUS_SILENCE_FRAME;
			},
		};
		const transmission = new VoiceAudioTransmission(source, harness.output);
		await flushWork();
		expect(harness.frames).toHaveLength(1);
		expect(transmission.playback.playedDurationMs).toBe(20);
		expect(harness.speaking).toEqual([{ value: true, at: 0 }]);

		await vi.advanceTimersByTimeAsync(140);
		await transmission.playback.done;
		expect(harness.frames).toHaveLength(7);
		expect(transmission.playback.playedDurationMs).toBe(40);
		expect(harness.frames.map(({ at }) => at)).toEqual([0, 20, 40, 60, 80, 100, 120]);
		expect(harness.speaking).toEqual([
			{ value: true, at: 0 },
			{ value: false, at: 140 },
		]);
	});

	test('finishes an underflow cleanly and resumes the same playback when data returns', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const nextPacket = Promise.withResolvers<Uint8Array>();
		const harness = createOutput();
		const source = {
			async *[Symbol.asyncIterator]() {
				yield OPUS_SILENCE_FRAME;
				yield await nextPacket.promise;
			},
		};
		const transmission = new VoiceAudioTransmission(source, harness.output);
		await flushWork();
		await vi.advanceTimersByTimeAsync(200);
		expect(transmission.playback.playedDurationMs).toBe(20);
		expect(harness.speaking.at(-1)).toEqual({ value: false, at: 120 });
		let completed = false;
		void transmission.playback.done.then(() => {
			completed = true;
		});
		expect(completed).toBe(false);

		nextPacket.resolve(OPUS_SILENCE_FRAME);
		await flushWork();
		expect(transmission.playback.playedDurationMs).toBe(40);
		expect(harness.advanced).toEqual([3_840]);
		expect(harness.speaking.at(-1)).toEqual({ value: true, at: 200 });
		await vi.advanceTimersByTimeAsync(120);
		await transmission.playback.done;
		expect(harness.speaking.at(-1)).toEqual({ value: false, at: 320 });
	});

	test('stops before the first packet without waiting for an uncooperative source', async () => {
		const returned = vi.fn();
		const source = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
					return: () => {
						returned();
						return new Promise<IteratorResult<Uint8Array>>(() => {});
					},
				};
			},
		};
		const transmission = new VoiceAudioTransmission(source, createOutput().output);

		await expect(transmission.playback.stop()).resolves.toBeUndefined();
		expect(returned).toHaveBeenCalledOnce();
	});

	test('does not count a source packet when the transport rejects it', async () => {
		const failure = new Error('send failed');
		const harness = createOutput();
		harness.output.sendFrame = vi.fn(async () => {
			throw failure;
		});
		const source = {
			async *[Symbol.asyncIterator]() {
				yield OPUS_SILENCE_FRAME;
			},
		};
		const transmission = new VoiceAudioTransmission(source, harness.output);

		await expect(transmission.playback.done).rejects.toBe(failure);
		expect(transmission.playback.playedDurationMs).toBe(0);
	});

	test('uses each Opus packet sample count instead of assuming a fixed frame duration', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = createOutput();
		const sixtyMillisecondPacket = Uint8Array.of(0x18);
		const source = {
			async *[Symbol.asyncIterator]() {
				yield sixtyMillisecondPacket;
			},
		};
		const transmission = new VoiceAudioTransmission(source, harness.output);
		await flushWork();

		expect(transmission.playback.playedDurationMs).toBe(60);
		await vi.advanceTimersByTimeAsync(160);
		await transmission.playback.done;
		expect(transmission.playback.playedDurationMs).toBe(60);
	});

	test('does not send a resolved lookahead packet after stop fences the transmission', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const first = Uint8Array.of(0xf8, 1);
		const second = Uint8Array.of(0xf8, 2);
		const harness = createOutput();
		const source = {
			async *[Symbol.asyncIterator]() {
				yield first;
				yield second;
			},
		};
		const transmission = new VoiceAudioTransmission(source, harness.output);
		await flushWork();
		expect(harness.frames.map(({ frame }) => frame)).toEqual([first]);

		await vi.advanceTimersByTimeAsync(5);
		const stopped = transmission.playback.stop();
		await flushWork();
		expect(harness.frames.map(({ frame }) => frame)).toEqual([first]);

		await vi.advanceTimersByTimeAsync(115);
		await stopped;
		expect(transmission.playback.playedDurationMs).toBe(20);
		expect(harness.frames.map(({ frame }) => frame)).toEqual([
			first,
			OPUS_SILENCE_FRAME,
			OPUS_SILENCE_FRAME,
			OPUS_SILENCE_FRAME,
			OPUS_SILENCE_FRAME,
			OPUS_SILENCE_FRAME,
		]);
	});
});
