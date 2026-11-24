import type { CacheReconcilerCoordinator } from '../coordinator';

/**
 * Coordinates reconciliation inside one process.
 *
 * It keeps visibility and causal state in memory, so it only fences writers that share this process.
 */
export function memoryCoordinator(): CacheReconcilerCoordinator {
	return { kind: 'memory' };
}
