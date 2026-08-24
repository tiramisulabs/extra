import type { DispatchDenial } from '../bot/dispatch-context';
import { asRecord } from '../bot/state';
import type { CapturedErrorView, DispatchFacts, RenderedSubject } from './types';

/**
 * The dispatch-level facts of a subject: the denial that stopped it, and the unhandled error it captured.
 *
 * Returns `undefined` — not `{}` — for every subject that is not a `DispatchResult`, so `get.denial()` on a
 * `MockBot`, an actor, a parked flow, a mock context or a raw payload can say the subject cannot be denied
 * instead of reporting a miss against zero candidates.
 *
 * `denied` is the discriminator because it is the one field of the three that is always there: it is declared
 * non-optional and the single site that builds a `DispatchResult` always sets it, while `denial` and `error`
 * are absent on the happy path, which is most dispatches.
 */
export function dispatchFactsOf(subject: RenderedSubject): DispatchFacts | undefined {
	const record = asRecord(subject);
	if (typeof record.denied !== 'boolean') return undefined;
	return {
		...denialFact(record.denial),
		...('error' in record ? { error: { kind: 'error', error: record.error } satisfies CapturedErrorView } : {}),
	};
}

function denialFact(value: unknown): Pick<DispatchFacts, 'denial'> {
	if (!value || typeof value !== 'object') return {};
	const denial = value as DispatchDenial;
	return {
		denial: {
			kind: 'denial',
			denialKind: denial.kind,
			...(denial.reason === undefined ? {} : { reason: denial.reason }),
			...(denial.middleware === undefined ? {} : { middleware: denial.middleware }),
			missing: denial.missing ?? [],
			raw: denial,
		},
	};
}
