import type { SelectMenuInteractionOptions } from './interactions';
import type { RecordedAction } from './rest';
import { numberValue, walkComponents } from './state';

/**
 * Pure helpers for walking a message's component tree (action rows + Components v2 nesting). No bot state — kept
 * out of bot.ts so the dispatch orchestrator stays focused. Counterpart to state.ts's `harvestComponents`, which
 * flattens to typed views; these answer "does this customId/type exist in the raw tree".
 */

/** Find the node whose `custom_id` matches anywhere in the tree, returning the raw node. */
export function findComponentNode(components: unknown, customId: string): Record<string, unknown> | undefined {
	let found: Record<string, unknown> | undefined;
	walkComponents(components, node => {
		if (!found && node.custom_id === customId) found = node;
	});
	return found;
}

/** The numeric `type` of the node matching `customId`, used to cross-check a component dispatch verb. */
export function findComponentType(components: unknown, customId: string): number | undefined {
	return numberValue(findComponentNode(components, customId)?.type);
}

/** True when a recorded REST action's body rendered a component with `customId` (top-level send/edit or an interaction-callback `data` payload). */
export function actionRendersComponent(action: RecordedAction, customId: string): boolean {
	const body = action.body as { components?: unknown; data?: { components?: unknown } } | undefined;
	return (
		findComponentNode(body?.components, customId) !== undefined ||
		findComponentNode(body?.data?.components, customId) !== undefined
	);
}

export function selectTypeForInteraction(
	type: number | undefined,
): SelectMenuInteractionOptions['componentType'] | undefined {
	if (type === undefined) return undefined;
	return type === 3 || (type >= 5 && type <= 8) ? (type as 3 | 5 | 6 | 7 | 8) : undefined;
}

/** Collect every nested custom_id in a modal's component tree (text inputs, possibly wrapped in Label rows). */
export function collectComponentCustomIds(components: unknown, into: Set<string>): void {
	if (!Array.isArray(components)) return;
	for (const node of components) {
		if (!node || typeof node !== 'object') continue;
		const entry = node as { custom_id?: string; component?: unknown; components?: unknown };
		if (typeof entry.custom_id === 'string') into.add(entry.custom_id);
		collectComponentCustomIds(entry.components, into);
		if (entry.component) collectComponentCustomIds([entry.component], into);
	}
}
