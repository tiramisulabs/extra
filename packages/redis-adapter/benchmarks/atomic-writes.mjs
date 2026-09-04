import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createClient } from '@redis/client';
import { ExpirableRedisAdapter, RedisAdapter, toDb, toNormal } from '../lib/index.js';

const samples = positiveInteger('BENCH_SAMPLES', process.env.BENCH_COMPARE_MODULE ? 6 : 8);
const operations = positiveInteger('BENCH_OPERATIONS', 3_000);
const warmupOperations = positiveInteger('BENCH_WARMUP', 300);
const batchSize = positiveInteger('BENCH_BATCH_SIZE', 100);
const batches = positiveInteger('BENCH_BATCHES', 300);
const atomicChunkSize = 100;
const concurrency = positiveInteger('BENCH_CONCURRENCY', 1);
const payload = process.env.BENCH_PAYLOAD ?? 'small';
if (payload !== 'small' && payload !== 'role') throw new RangeError('BENCH_PAYLOAD must be small or role');
const referenceModule = process.env.BENCH_COMPARE_MODULE
	? await import(pathToFileURL(resolve(process.env.BENCH_COMPARE_MODULE)).href)
	: undefined;
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
	await Promise.all(
		Array.from({ length: Math.min(concurrency, count) }, async (_, lane) => {
			for (let index = lane; index < count; index += concurrency) {
				const operationStartedAt = performance.now();
				await run(index);
				latencies.push(performance.now() - operationStartedAt);
			}
		}),
	);
	return { latencies, throughput: (count * unitsPerOperation * 1_000) / (performance.now() - startedAt) };
}

async function measureScenario({ name, implementations, operationCount = operations, unitsPerOperation = 1 }) {
	for (const implementation of implementations) {
		await implementation.reset();
		await timeOperations(Math.min(warmupOperations, operationCount), implementation.run, unitsPerOperation);
	}
	const measurements = implementations.map(() => []);
	for (let sample = 0; sample < samples; sample++) {
		// Rotate order so every arm runs first equally often when samples is a multiple of the arm count.
		for (let offset = 0; offset < implementations.length; offset++) {
			const index = (sample + offset) % implementations.length;
			const implementation = implementations[index];
			await implementation.reset();
			const result = await timeOperations(operationCount, implementation.run, unitsPerOperation);
			await implementation.verify(operationCount);
			measurements[index].push(result);
		}
	}
	const referenceIndex = implementations.findIndex(implementation => implementation.name === 'atomic reference');
	return implementations.map((implementation, index) => {
		const results = measurements[index];
		const throughputs = results.map(result => result.throughput);
		const pairedDeltas =
			referenceIndex >= 0 && implementation.name === 'atomic current'
				? results.map(
						(result, sample) => (result.throughput / measurements[referenceIndex][sample].throughput - 1) * 100,
					)
				: undefined;
		return {
			workload: name,
			implementation: implementation.name,
			latencyP50: milliseconds(median(results.map(result => median(result.latencies)))),
			latencyP95: milliseconds(median(results.map(result => percentile(result.latencies, 0.95)))),
			throughput: `${Math.round(median(throughputs))} +/- ${Math.round(mad(throughputs))}`,
			vsReference: pairedDeltas ? `${median(pairedDeltas).toFixed(1)}% +/- ${mad(pairedDeltas).toFixed(1)}pp` : '',
			roundTrips: implementation.roundTrips,
		};
	});
}

function roleData(index) {
	const value = { id: String(index), name: `role-${index}` };
	return payload === 'small'
		? value
		: {
				...value,
				color: 0x5865f2,
				colors: { primary_color: 0x5865f2, secondary_color: null, tertiary_color: null },
				hoist: true,
				icon: null,
				managed: false,
				mentionable: true,
				permissions: '1099511627775',
				position: 3,
				tags: { bot_id: '123456789012345678' },
				unicode_emoji: '🎨',
			};
}

function atomicImplementations(create, expiring = false) {
	const adapters = [[expiring ? expirable : atomic, 'atomic current']];
	if (referenceModule) adapters.unshift([expiring ? referenceExpirable : reference, 'atomic reference']);
	return adapters.map(([adapter, name]) => ({ name, ...create(adapter) }));
}

const patchKey = index => `role.shared-${index % concurrency}`;

async function seedPatch(write) {
	for (let lane = 0; lane < Math.min(concurrency, operations); lane++) {
		await write(patchKey(lane), { ...roleData(`shared-${lane}`), generation: -1 });
	}
}

async function verifyPatch(read, count) {
	for (let lane = 0; lane < Math.min(concurrency, count); lane++) {
		const expected = lane + Math.floor((count - 1 - lane) / concurrency) * concurrency;
		if (Number((await read(patchKey(lane))).generation) !== expected) throw new Error('patch oracle failed');
	}
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
const reference = referenceModule
	? new referenceModule.RedisAdapter({
			namespace: `bench-reference-${runId}`,
			redisOptions: { url: redisUrl },
		})
	: undefined;
const referenceExpirable = referenceModule
	? new referenceModule.ExpirableRedisAdapter(
			{
				namespace: `bench-reference-expirable-${runId}`,
				redisOptions: { url: redisUrl },
			},
			{ default: { expire: 60_000 } },
		)
	: undefined;
await Promise.all([
	baseline.connect(),
	atomic.start(),
	expirable.start(),
	reference?.start(),
	referenceExpirable?.start(),
]);

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
	await verifyValues(client, baselinePrefix, expected);
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
	await verifyValues(client, prefix, expected);
};

async function verifyValues(client, prefix, count) {
	for (const index of new Set([0, count - 1])) {
		assert.deepStrictEqual(toNormal(await client.hGetAll(`${prefix}role.${index}`)), roleData(index));
	}
}

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
		`Redis ${redisVersion}; Node ${process.version}; samples=${samples}; operations=${operations}; batches=${batches}; batchSize=${batchSize}; warmup=${warmupOperations}; concurrency=${concurrency}; payload=${payload}`,
	);
	console.log('Latency is milliseconds per awaited operation. Throughput is logical entries/second (median +/- MAD).');
	console.log('Sample order rotates between implementations; reference deltas are paired medians +/- MAD.');
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
						await baseline.sAdd(legacyRelationship('role.guild-1'), String(index));
						await baseline
							.multi()
							.del(baselineValue(key))
							.hSet(baselineValue(key), toDb(roleData(index)))
							.exec();
					},
					verify: count => verifyLegacyRelationship(baseline, 'role.guild-1', count),
				},
				...atomicImplementations(adapter => ({
					roundTrips: '1/entry',
					reset: () => adapter.flush(),
					run: index => adapter.set(`role.${index}`, roleData(index), ['role.guild-1', String(index)]),
					verify: count => verifyRelationship(adapter.client, `${adapter.namespace}:`, 'role.guild-1', count, true),
				})),
			],
		})),
	);

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
						await baseline.sAdd(legacyRelationship('role.guild-1'), ids);
						const valueCommands = [];
						for (let offset = 0; offset < batchSize; offset++) {
							const index = batch * batchSize + offset;
							const key = `role.${index}`;
							valueCommands.push(
								baseline
									.multi()
									.del(baselineValue(key))
									.hSet(baselineValue(key), toDb(roleData(index)))
									.exec(),
							);
						}
						await Promise.all(valueCommands);
					},
					verify: count => verifyLegacyRelationship(baseline, 'role.guild-1', count * batchSize),
				},
				...atomicImplementations(adapter => ({
					roundTrips: `${atomicChunksPerBatch}/batch`,
					reset: () => adapter.flush(),
					run: batch =>
						adapter.bulkSet(
							Array.from({ length: batchSize }, (_, offset) => {
								const index = batch * batchSize + offset;
								return [`role.${index}`, roleData(index), ['role.guild-1', String(index)]];
							}),
						),
					verify: count =>
						verifyRelationship(adapter.client, `${adapter.namespace}:`, 'role.guild-1', count * batchSize, true),
				})),
			],
		})),
	);

	for (const expiring of [false, true]) {
		rows.push(
			...(await measureScenario({
				name: expiring ? 'patch with TTL' : 'patch one entry',
				implementations: [
					...(!expiring
						? [
								{
									name: 'historical split baseline',
									roundTrips: '2/entry',
									reset: async () => {
										await deletePrefix(baseline, baselinePrefix);
										await seedPatch((key, value) => baseline.hSet(baselineValue(key), toDb(value)));
									},
									run: async index => {
										const key = patchKey(index);
										await baseline.hSet(baselineRelationship('role.guild-1'), key.slice(5), key);
										await baseline.hSet(baselineValue(key), 'N_generation', String(index));
									},
									verify: count =>
										verifyPatch(async key => toNormal(await baseline.hGetAll(baselineValue(key))), count),
								},
							]
						: []),
					...atomicImplementations(
						adapter => ({
							roundTrips: '2/entry (read + script)',
							reset: async () => {
								await adapter.flush();
								await seedPatch((key, value) => adapter.set(key, value, ['role.guild-1', key.slice(5)]));
							},
							run: index => {
								const key = patchKey(index);
								return adapter.patch(key, { generation: index }, ['role.guild-1', key.slice(5)]);
							},
							verify: count => verifyPatch(key => adapter.get(key), count),
						}),
						expiring,
					),
				],
			})),
		);
	}

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
							.hSet(baselineValue(key), toDb(roleData(index)))
							.pExpire(baselineValue(key), 60_000)
							.exec();
						await baseline.hSetEx(
							baselineRelationship('role.guild-1'),
							{ [index]: key },
							{ expiration: { type: 'PX', value: 60_000 } },
						);
					},
					verify: count => verifyRelationship(baseline, baselinePrefix, 'role.guild-1', count),
				},
				...atomicImplementations(
					adapter => ({
						roundTrips: '1/entry',
						reset: () => adapter.flush(),
						run: index => adapter.set(`role.${index}`, roleData(index), ['role.guild-1', String(index)]),
						verify: async count => {
							await verifyRelationship(adapter.client, `${adapter.namespace}:`, 'role.guild-1', count, true);
							await verifyExpirations(adapter.client, `${adapter.namespace}:`, 'role.guild-1', count);
						},
					}),
					true,
				),
			],
		})),
	);

	console.table(rows);
} finally {
	await Promise.all([
		deletePrefix(baseline, baselinePrefix),
		atomic.flush(),
		expirable.flush(),
		reference?.flush(),
		referenceExpirable?.flush(),
	]);
	baseline.close();
	atomic.client.close();
	expirable.client.close();
	reference?.client.close();
	referenceExpirable?.client.close();
}
