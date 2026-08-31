import { assert, describe, test } from 'vitest';
import { PacketCorrelation } from '../src/state';

type CorrelationPacket = Parameters<PacketCorrelation['preregister']>[0];

function packet(sequence: number, marker: string): CorrelationPacket {
	return {
		d: { id: '175928847299117063', marker },
		s: sequence,
		t: 'RAW_GUILD_CREATE',
	};
}

function clonePacket(input: CorrelationPacket): CorrelationPacket {
	const data = typeof input.d === 'object' && input.d !== null ? { ...input.d } : input.d;
	return { ...input, d: data };
}

describe('PacketCorrelation', () => {
	test('correlates only the exact final payload identity', () => {
		const correlation = new PacketCorrelation();
		const input = packet(40, 'one');
		const final = clonePacket(input);
		const record = correlation.preregister(input, 3);

		assert.equal(correlation.bindFinal(record, final), 'bound');
		assert.equal(correlation.consume(clonePacket(final)), undefined);
		assert.equal(correlation.status().pending, 1);
		assert.equal(correlation.consume(final)?.sequence, 40);
		assert.deepEqual(correlation.status(), { failed: 0, matched: 1, pending: 0, settled: 1 });
	});

	test('fails closed when a downstream replacement changes causal entity identity', () => {
		const correlation = new PacketCorrelation();
		const input = packet(41, 'one');
		const record = correlation.preregister(input, 3);
		const changed = { ...input, d: { ...(input.d as object), id: '175928847299117099' } };

		assert.equal(correlation.bindFinal(record, changed), 'failed');
		assert.equal(record.outcome, 'identity-failed');
		assert.deepEqual(correlation.status(), { failed: 1, matched: 0, pending: 0, settled: 1 });
	});

	test('matches identical payloads in reverse completion without FIFO fallback', () => {
		const correlation = new PacketCorrelation();
		const firstInput = packet(50, 'same');
		const secondInput = packet(51, 'same');
		const firstFinal = clonePacket(firstInput);
		const secondFinal = clonePacket(secondInput);
		const first = correlation.preregister(firstInput, 2);
		const second = correlation.preregister(secondInput, 2);

		assert.equal(correlation.bindFinal(first, firstFinal), 'bound');
		assert.equal(correlation.bindFinal(second, secondFinal), 'bound');
		assert.equal(correlation.consume(secondFinal)?.sequence, 51);
		assert.equal(correlation.consume(firstFinal)?.sequence, 50);
		assert.deepEqual(correlation.status(), { failed: 0, matched: 2, pending: 0, settled: 2 });
	});

	test('fails closed when two records reuse one final payload identity', async () => {
		const correlation = new PacketCorrelation();
		const firstPacket = packet(60, 'same');
		const secondPacket = packet(60, 'same');
		const sharedFinal = clonePacket(firstPacket);
		const first = correlation.preregister(firstPacket, 1);
		const second = correlation.preregister(secondPacket, 1);

		assert.equal(correlation.bindFinal(first, sharedFinal), 'bound');
		assert.equal(correlation.bindFinal(second, sharedFinal), 'failed');
		await correlation.waitForIdle();
		assert.deepEqual(correlation.status(), { failed: 2, matched: 0, pending: 0, settled: 2 });
	});

	test('scopes sequence reuse to READY generations', () => {
		const correlation = new PacketCorrelation();
		const generationOne = Object.freeze({ id: 1, kind: 'shard' as const, sessionId: 'one', shardId: 0 });
		const generationTwo = Object.freeze({ id: 2, kind: 'shard' as const, sessionId: 'two', shardId: 0 });
		const readyOne = { d: { guilds: [], session_id: 'one' }, s: 1, t: 'READY' };
		const readyTwo = { d: { guilds: [], session_id: 'two' }, s: 1, t: 'READY' };

		const first = correlation.preregister(readyOne, 0, generationOne);
		correlation.bindFinal(first, readyOne);
		correlation.consume(readyOne);
		const second = correlation.preregister(readyTwo, 0, generationTwo);
		correlation.bindFinal(second, readyTwo);
		correlation.consume(readyTwo);

		assert.equal(first.generation, generationOne);
		assert.equal(second.generation, generationTwo);
	});

	test('settles a preregistration exactly once', async () => {
		const correlation = new PacketCorrelation();
		const record = correlation.preregister(packet(70, 'failure'), 1);
		correlation.settle(record, 'downstream-error');
		correlation.settle(record, 'post-cache');

		await correlation.waitForIdle();
		assert.equal(record.outcome, 'downstream-error');
		assert.deepEqual(correlation.status(), { failed: 1, matched: 0, pending: 0, settled: 1 });
	});
});
