import type { BatchObservableResult } from '@opentelemetry/api';
import type { Client } from 'seyfert';
import { getMeter } from '../trace-api';
import type { InstrumentTarget } from './deps';

export function instrumentCollectors(target: InstrumentTarget): () => void {
	const meter = getMeter();
	const active = meter.createObservableGauge('seyfert.collector.active', {
		unit: '{registration}',
		description: 'Currently registered component collectors, event collectors, and modal callbacks',
	});
	const observe = (result: BatchObservableResult): void => {
		try {
			const client = target.client as Partial<Pick<Client, 'components' | 'collectors'>> | undefined;
			if (client?.components) {
				result.observe(active, client.components.values.size, { 'seyfert.collector.type': 'component' });
				result.observe(active, client.components.modals.size, { 'seyfert.collector.type': 'modal' });
			}
			if (client?.collectors) {
				let count = 0;
				for (const collectors of client.collectors.values.values()) count += collectors.length;
				result.observe(active, count, { 'seyfert.collector.type': 'event' });
			}
		} catch {
			// A failing handler must not interrupt the host's metric export.
		}
	};

	meter.addBatchObservableCallback(observe, [active]);
	return () => meter.removeBatchObservableCallback(observe, [active]);
}
