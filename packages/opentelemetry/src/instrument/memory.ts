import process from 'node:process';
import type { BatchObservableResult } from '@opentelemetry/api';
import { getMeter } from '../trace-api';

export function instrumentMemory(): () => void {
	const meter = getMeter();
	const memory = meter.createObservableGauge('seyfert.process.memory.usage', {
		unit: 'By',
		description: 'Memory reported by the runtime for the process, including all libraries and application code',
	});
	const observe = (result: BatchObservableResult): void => {
		try {
			const usage = process.memoryUsage();
			for (const type of ['rss', 'heapUsed', 'heapTotal', 'external'] as const) {
				result.observe(memory, usage[type], { 'seyfert.memory.type': type });
			}
		} catch {
			// Memory collection must not interrupt the host's metric export.
		}
	};

	meter.addBatchObservableCallback(observe, [memory]);
	return () => meter.removeBatchObservableCallback(observe, [memory]);
}
