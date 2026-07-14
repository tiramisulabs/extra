import { describe, expect, it } from 'vitest';
import { placementCapacity, planPlacement } from '../src/placement';
import type { ConnectedScalerHost, LogicalWorker } from '../src/types';

const workers: LogicalWorker[] = [0, 1, 2].map(workerId => ({
	workerId,
	shardStart: workerId,
	shardEnd: workerId + 1,
	totalShards: 3,
}));

function host(hostId: string, maxWorkers: number, connectedAt: number, observed = 0): ConnectedScalerHost {
	return {
		descriptor: { hostId, bootId: `${hostId}-boot`, maxWorkers },
		connectedAt,
		lastSeenAt: connectedAt,
		observed: Array.from({ length: observed }, (_, workerId) => ({
			workerId: workerId + 100,
			identity: { slot: `${hostId}:${workerId}`, token: `${hostId}:${workerId}:token` },
			topology: { shardStart: 0, shardEnd: 1, totalShards: 1 },
			ready: true,
		})),
	};
}

describe('placement', () => {
	it('spreads workers deterministically across capacity', () => {
		expect(
			planPlacement({ workers, hosts: [host('b', 2, 2), host('a', 2, 1)], strategy: 'spread' }).map(
				value => value.hostId,
			),
		).toEqual(['a', 'b', 'a']);
	});

	it('fills older hosts first', () => {
		expect(
			planPlacement({ workers, hosts: [host('new', 2, 2), host('old', 2, 1)], strategy: 'fill-first' }).map(
				value => value.hostId,
			),
		).toEqual(['old', 'old', 'new']);
	});

	it('includes observed load when spreading and calculating capacity', () => {
		const hosts = [host('a', 2, 1, 1), host('b', 2, 2)];
		expect(placementCapacity(hosts)).toBe(3);
		expect(planPlacement({ workers: workers.slice(0, 1), hosts, strategy: 'spread' })[0]?.hostId).toBe('b');
	});

	it('fills only the unused capacity of older hosts', () => {
		expect(
			planPlacement({
				workers: workers.slice(0, 2),
				hosts: [host('new', 2, 2), host('old', 2, 1, 1)],
				strategy: 'fill-first',
			}).map(value => value.hostId),
		).toEqual(['old', 'new']);
	});

	it('fails rather than overcommitting hosts', () => {
		expect(() => planPlacement({ workers, hosts: [host('a', 2, 1)], strategy: 'spread' })).toThrow(
			/Insufficient host capacity/,
		);
	});
});
