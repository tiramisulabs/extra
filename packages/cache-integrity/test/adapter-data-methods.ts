import type { Adapter } from 'seyfert';
import type { ReconciledAdapter } from '../src/adapter';

export type AdapterDataMethod = Exclude<keyof Adapter, 'isAsync' | 'start'>;

export const adapterDataCalls = {
	scan: (adapter: ReconciledAdapter) => adapter.scan('item.*', true),
	bulkGet: (adapter: ReconciledAdapter) => adapter.bulkGet(['item.one']),
	get: (adapter: ReconciledAdapter) => adapter.get('item.one'),
	bulkSet: (adapter: ReconciledAdapter) => adapter.bulkSet([['item.one', { id: 'one' }]]),
	set: (adapter: ReconciledAdapter) => adapter.set('item.one', { id: 'one' }),
	bulkPatch: (adapter: ReconciledAdapter) => adapter.bulkPatch([['item.one', { updated: true }]]),
	patch: (adapter: ReconciledAdapter) => adapter.patch('item.one', { updated: true }),
	values: (adapter: ReconciledAdapter) => adapter.values('item'),
	keys: (adapter: ReconciledAdapter) => adapter.keys('item'),
	count: (adapter: ReconciledAdapter) => adapter.count('item'),
	bulkRemove: (adapter: ReconciledAdapter) => adapter.bulkRemove(['item.one']),
	remove: (adapter: ReconciledAdapter) => adapter.remove('item.one'),
	flush: (adapter: ReconciledAdapter) => adapter.flush(),
	contains: (adapter: ReconciledAdapter) => adapter.contains('item', 'one'),
	getToRelationship: (adapter: ReconciledAdapter) => adapter.getToRelationship('item'),
	bulkAddToRelationShip: (adapter: ReconciledAdapter) => adapter.bulkAddToRelationShip({ item: ['one'] }),
	addToRelationship: (adapter: ReconciledAdapter) => adapter.addToRelationship('item', 'one'),
	removeToRelationship: (adapter: ReconciledAdapter) => adapter.removeToRelationship('item', 'one'),
	removeRelationship: (adapter: ReconciledAdapter) => adapter.removeRelationship('item'),
} satisfies Record<AdapterDataMethod, (adapter: ReconciledAdapter) => unknown>;

export const adapterReadMethods = [
	'scan',
	'bulkGet',
	'get',
	'values',
	'keys',
	'count',
	'contains',
	'getToRelationship',
] as const satisfies readonly AdapterDataMethod[];
