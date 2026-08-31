import type { ReconciliationCoordinator } from '../coordinator';

export interface LocalCoordinator extends ReconciliationCoordinator {
	readonly kind: 'local';
}

export function localCoordinator(): LocalCoordinator {
	return {
		kind: 'local',
		start() {},
		close() {},
	};
}
