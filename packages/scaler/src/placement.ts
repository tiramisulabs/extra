import type { ConnectedScalerHost, LogicalWorker, PlacementLocation, PlacementStrategy } from './types';

export interface PlannedAssignment extends PlacementLocation {
	workerId: number;
}

interface PlacementInput {
	readonly workers: readonly LogicalWorker[];
	readonly hosts: readonly ConnectedScalerHost[];
	readonly strategy: PlacementStrategy;
}

export function planPlacement(input: PlacementInput): readonly PlannedAssignment[] {
	const workers = canonicalWorkers(input.workers);
	const hosts = validateHosts(input.hosts);
	if (placementCapacity(hosts) < workers.length) throw new RangeError('Insufficient host capacity');

	if (input.strategy === 'fill-first') return fillFirst(workers, hosts);
	if (input.strategy !== 'spread') throw new RangeError(`Unknown placement strategy: ${String(input.strategy)}`);
	return spread(workers, hosts);
}

export function placementCapacity(hosts: readonly ConnectedScalerHost[]) {
	return validateHosts(hosts).reduce((total, host) => {
		const capacity = total + Math.max(0, host.descriptor.maxWorkers - host.observed.length);
		if (!Number.isSafeInteger(capacity)) throw new RangeError('Aggregate host capacity must be a safe integer');
		return capacity;
	}, 0);
}

function spread(workers: readonly LogicalWorker[], hostsInput: readonly ConnectedScalerHost[]) {
	const hosts = [...hostsInput].sort(compareHost);
	const loads = new Map(hosts.map(host => [host, host.observed.length]));
	return workers.map(worker => {
		const host = hosts
			.filter(candidate => loads.get(candidate)! < candidate.descriptor.maxWorkers)
			.sort((left, right) => {
				const load = loads.get(left)! / left.descriptor.maxWorkers - loads.get(right)! / right.descriptor.maxWorkers;
				return load || compareHost(left, right);
			})[0];
		if (!host) throw new RangeError(`No capacity for worker ${worker.workerId}`);
		loads.set(host, loads.get(host)! + 1);
		return assignment(worker, host);
	});
}

function fillFirst(workers: readonly LogicalWorker[], hostsInput: readonly ConnectedScalerHost[]) {
	const hosts = [...hostsInput].sort((left, right) => left.connectedAt - right.connectedAt || compareHost(left, right));
	const assignments: PlannedAssignment[] = [];
	let workerIndex = 0;
	for (const host of hosts) {
		for (
			let used = host.observed.length;
			used < host.descriptor.maxWorkers && workerIndex < workers.length;
			used++, workerIndex++
		) {
			assignments.push(assignment(workers[workerIndex]!, host));
		}
		if (workerIndex === workers.length) break;
	}
	return assignments;
}

function canonicalWorkers(workersInput: readonly LogicalWorker[]) {
	if (!workersInput.length) throw new RangeError('Placement requires at least one logical worker');
	const workers = [...workersInput].sort((left, right) => left.workerId - right.workerId);
	for (let index = 0; index < workers.length; index++) {
		const worker = workers[index]!;
		if (
			!Number.isSafeInteger(worker.workerId) ||
			worker.workerId < 0 ||
			worker.workerId === workers[index - 1]?.workerId
		) {
			throw new RangeError('Logical worker ids must be unique non-negative integers');
		}
	}
	return workers;
}

function validateHosts(hostsInput: readonly ConnectedScalerHost[]) {
	const hosts = [...hostsInput];
	const hostIds = new Set<string>();
	for (const host of hosts) {
		const { hostId, bootId, maxWorkers } = host.descriptor;
		if (!hostId || !bootId) throw new RangeError('Host identity must be non-empty');
		if (hostIds.has(hostId)) throw new RangeError(`Host id ${hostId} must be unique`);
		if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) {
			throw new RangeError(`Host ${hostId} maxWorkers must be a positive integer`);
		}
		hostIds.add(hostId);
	}
	return hosts;
}

function assignment(worker: LogicalWorker, host: ConnectedScalerHost): PlannedAssignment {
	return { workerId: worker.workerId, hostId: host.descriptor.hostId, bootId: host.descriptor.bootId };
}

function compareHost(left: ConnectedScalerHost, right: ConnectedScalerHost) {
	return (
		left.descriptor.hostId.localeCompare(right.descriptor.hostId) ||
		left.descriptor.bootId.localeCompare(right.descriptor.bootId)
	);
}
