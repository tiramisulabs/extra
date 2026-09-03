import { performance } from 'node:perf_hooks';
import { createClient } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter } from '../lib/index.js';

const samples = positiveInteger('BENCH_SAMPLES', 7);
const operations = positiveInteger('BENCH_OPERATIONS', 300);
const warmupOperations = positiveInteger('BENCH_WARMUP', 50);
const batchSize = positiveInteger('BENCH_BATCH_SIZE', 100);
const batches = positiveInteger('BENCH_BATCHES', 100);
const atomicChunkSize = 100;
const redisUrl = process.env.SLIPHER_REDIS_URL ?? 'redis://127.0.0.1:6379';
const runId = `${process.pid}-${Date.now()}`;

function positiveInteger(name, fallback) {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function mad(values) {
	const center = median(values);
	return median(values.map(value => Math.abs(value - center)));
}

function milliseconds(value) {
	return value < 1 ? value.toFixed(3) : value.toFixed(2);
}

async function deletePrefix(client, prefix) {
	let keys = [];
	for await (const batch of client.scanIterator({ MATCH: `${prefix}*` })) {
		keys.push(...batch);
		if (keys.length >= 500) {
			await client.del(keys);
			keys = [];
		}
	}
	if (keys.length) await client.del(keys);
}

async function timeOperations(count, run, unitsPerOperation = 1) {
	const latencies = [];
	const startedAt = performance.now();
	for (let index = 0; index < count; index++) {
		const operationStartedAt = performance.now();
		await run(index);
		latencies.push(performance.now() - operationStartedAt);
	}
	const duration = performance.now() - startedAt;
	return {
		latencies,
		throughput: (count * unitsPerOperation * 1_000) / duration,
	};
}

async function measureScenario({ name, implementations, operationCount = operations, unitsPerOperation = 1 }) {
	const rows = [];
	for (const implementation of implementations) {
		await implementation.reset();
		for (let index = 0; index < Math.min(warmupOperations, operationCount); index++) {
			await implementation.run(index);
		}

		const measurements = [];
		for (let sample = 0; sample < samples; sample++) {
			await implementation.reset();
			const result = await timeOperations(operationCount, implementation.run, unitsPerOperation);
			await implementation.verify(operationCount, unitsPerOperation);
			measurements.push(result);
		}

		const throughputs = measurements.map(result => result.throughput);
		rows.push({
			workload: name,
			implementation: implementation.name,
			latencyP50: milliseconds(median(measurements.map(result => median(result.latencies)))),
			latencyP95: milliseconds(median(measurements.map(result => percentile(result.latencies, 0.95)))),
			throughput: `${Math.round(median(throughputs))} +/- ${Math.round(mad(throughputs))}`,
			roundTrips: implementation.roundTrips,
		});
	}
	return rows;
}

const baseline = createClient({ url: redisUrl });
const atomic = new RedisAdapter({
	namespace: `bench-atomic-${runId}`,
	redisOptions: { url: redisUrl },
});
const expirable = new ExpirableRedisAdapter(
	{
		namespace: `bench-expirable-${runId}`,
		redisOptions: { url: redisUrl },
	},
	{ default: { expire: 60_000 } },
);
await Promise.all([baseline.connect(), atomic.start(), expirable.start()]);

const baselinePrefix = `bench-baseline-${runId}:`;
const baselineValue = key => `${baselinePrefix}${key}`;
const baselineRelationship = to => `${baselinePrefix}relationships:${to}`;
const legacyRelationship = to => `${baselinePrefix}${to}:set`;

const verifyLegacyRelationship = async (client, to, expected) => {
	const ids = await client.sMembers(legacyRelationship(to));
	if (ids.length !== expected) throw new Error(`legacy oracle failed for ${to}: expected ${expected} members`);
	for (const id of ids) {
		if (!(await client.exists(baselineValue(`role.${id}`))))
			throw new Error(`legacy oracle found dangling member ${to}.${id}`);
	}
};

const verifyRelationship = async (client, prefix, to, expected, verifyOwners = false) => {
	const relationship = await client.hGetAll(`${prefix}relationships:${to}`);
	if (Object.keys(relationship).length !== expected) {
		throw new Error(`oracle failed for ${to}: expected ${expected} relationship members`);
	}
	for (const [id, logicalKey] of Object.entries(relationship)) {
		if (!(await client.exists(`${prefix}${logicalKey}`))) throw new Error(`oracle found dangling member ${to}.${id}`);
		if (verifyOwners) {
			const owner = await client.hGet(`${prefix}relationships:owners`, logicalKey);
			if (owner !== `${to}.${id}`) throw new Error(`oracle found an invalid reverse owner for ${to}.${id}`);
		}
	}
};

const verifyExpirations = async (client, prefix, to, count) => {
	const now = Date.now();
	for (const index of [0, count - 1]) {
		const id = String(index);
		const logicalKey = `role.${id}`;
		const valueDeadline = await client.pExpireTime(`${prefix}${logicalKey}`);
		const [relationshipTtl] = await client.hpTTL(`${prefix}relationships:${to}`, id);
		const [ownerTtl] = await client.hpTTL(`${prefix}relationships:owners`, logicalKey);
		if (valueDeadline <= now || relationshipTtl <= 0 || ownerTtl <= 0) {
			throw new Error(`TTL oracle found a missing expiry for ${to}.${id}`);
		}
		const relationshipDeadline = now + relationshipTtl;
		const ownerDeadline = now + ownerTtl;
		if (Math.abs(valueDeadline - relationshipDeadline) > 100 || Math.abs(valueDeadline - ownerDeadline) > 100) {
			throw new Error(`TTL oracle found divergent deadlines for ${to}.${id}`);
		}
	}
};

try {
	const info = await baseline.info('server');
	const redisVersion = /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? 'unknown';
	console.log(
		`Redis ${redisVersion}; Node ${process.version}; samples=${samples}; operations=${operations}; batches=${batches}; batchSize=${batchSize}; warmup=${warmupOperations}`,
	);
	console.log('Latency is milliseconds per awaited operation. Throughput is logical entries/second (median +/- MAD).');
	console.log('RTT is the deterministic number of sequential client/server command boundaries, not TCP packet count.');

	const rows = [];
	rows.push(
		...(await measureScenario({
			name: 'set one entry',
			implementations: [
				{
					name: 'historical split baseline',
					roundTrips: '2/entry',
					reset: () => deletePrefix(baseline, baselinePrefix),
					run: async index => {
						const key = `role.${index}`;
						await baseline.sAdd(legacyRelationship('guild.1'), String(index));
						await baseline
							.multi()
							.del(baselineValue(key))
							.hSet(baselineValue(key), { id: String(index), name: `role-${index}` })
							.exec();
					},
					verify: count => verifyLegacyRelationship(baseline, 'guild.1', count),
				},
				{
					name: 'atomic Lua',
					roundTrips: '1/entry',
					reset: () => atomic.flush(),
					run: index =>
						atomic.set(`role.${index}`, { id: String(index), name: `role-${index}` }, ['guild.1', String(index)]),
					verify: count => verifyRelationship(atomic.client, `${atomic.namespace}:`, 'guild.1', count, true),
				},
			],
		})),
	);

	const bulkEntries = Array.from({ length: batchSize }, (_, index) => [
		`role.${index}`,
		{ id: String(index), name: `role-${index}` },
		['guild.1', String(index)],
	]);
	const atomicChunksPerBatch = Math.ceil(batchSize / atomicChunkSize);
	rows.push(
		...(await measureScenario({
			name: `bulkSet (${batchSize})`,
			operationCount: batches,
			unitsPerOperation: batchSize,
			implementations: [
				{
					name: 'historical split pipelined baseline',
					roundTrips: `2/batch (${(2 / batchSize).toFixed(3)}/entry)`,
					reset: () => deletePrefix(baseline, baselinePrefix),
					run: async batch => {
						const ids = [];
						for (let offset = 0; offset < batchSize; offset++) {
							const index = batch * batchSize + offset;
							ids.push(String(index));
						}
						await baseline.sAdd(legacyRelationship('guild.1'), ids);
						const valueCommands = [];
						for (let offset = 0; offset < batchSize; offset++) {
							const index = batch * batchSize + offset;
							const key = `role.${index}`;
							valueCommands.push(
								baseline
									.multi()
									.del(baselineValue(key))
									.hSet(baselineValue(key), { id: String(index), name: `role-${index}` })
									.exec(),
							);
						}
						await Promise.all(valueCommands);
					},
					verify: count => verifyLegacyRelationship(baseline, 'guild.1', count * batchSize),
				},
				{
					name: 'atomic pipelined contract',
					roundTrips: `${atomicChunksPerBatch}/batch (${(atomicChunksPerBatch / batchSize).toFixed(3)}/entry)`,
					reset: () => atomic.flush(),
					run: batch =>
						atomic.bulkSet(
							bulkEntries.map(([key, value, relationship], offset) => [
								`role.${batch * batchSize + offset}`,
								{ ...value, id: String(batch * batchSize + offset) },
								[relationship[0], String(batch * batchSize + offset)],
							]),
						),
					verify: count =>
						verifyRelationship(atomic.client, `${atomic.namespace}:`, 'guild.1', count * batchSize, true),
				},
			],
		})),
	);

	rows.push(
		...(await measureScenario({
			name: 'patch one entry',
			implementations: [
				{
					name: 'historical split baseline',
					roundTrips: '2/entry',
					reset: async () => {
						await deletePrefix(baseline, baselinePrefix);
						await baseline.hSet(baselineValue('role.shared'), { id: 'shared', generation: '0' });
					},
					run: async index => {
						await baseline.hSet(baselineRelationship('guild.1'), 'shared', 'role.shared');
						await baseline.hSet(baselineValue('role.shared'), 'generation', String(index));
					},
					verify: async count => {
						if ((await baseline.hGet(baselineValue('role.shared'), 'generation')) !== String(count - 1))
							throw new Error('patch oracle failed');
					},
				},
				{
					name: 'atomic Lua',
					roundTrips: '2/entry (read + script)',
					reset: async () => {
						await atomic.flush();
						await atomic.set('role.shared', { id: 'shared', generation: 0 }, ['guild.1', 'shared']);
					},
					run: index => atomic.patch('role.shared', { generation: index }, ['guild.1', 'shared']),
					verify: async count => {
						if ((await atomic.get('role.shared'))?.generation !== count - 1)
							throw new Error('atomic patch oracle failed');
					},
				},
			],
		})),
	);

	rows.push(
		...(await measureScenario({
			name: 'set with TTL',
			implementations: [
				{
					name: 'historical split baseline',
					roundTrips: '2/entry',
					reset: () => deletePrefix(baseline, baselinePrefix),
					run: async index => {
						const key = `role.${index}`;
						await baseline
							.multi()
							.hSet(baselineValue(key), { id: String(index) })
							.pExpire(baselineValue(key), 60_000)
							.exec();
						await baseline.hSetEx(
							baselineRelationship('guild.1'),
							{ [index]: key },
							{ expiration: { type: 'PX', value: 60_000 } },
						);
					},
					verify: count => verifyRelationship(baseline, baselinePrefix, 'guild.1', count),
				},
				{
					name: 'atomic Lua',
					roundTrips: '1/entry',
					reset: () => expirable.flush(),
					run: index => expirable.set(`role.${index}`, { id: String(index) }, ['guild.1', String(index)]),
					verify: async count => {
						await verifyRelationship(expirable.client, `${expirable.namespace}:`, 'guild.1', count, true);
						await verifyExpirations(expirable.client, `${expirable.namespace}:`, 'guild.1', count);
					},
				},
			],
		})),
	);

	console.table(rows);
} finally {
	await Promise.all([deletePrefix(baseline, baselinePrefix), atomic.flush(), expirable.flush()]);
	baseline.close();
	atomic.client.close();
	expirable.client.close();
}
