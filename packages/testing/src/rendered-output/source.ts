import type { RecordedAction } from '../bot/rest';

type RenderedActionsReader = () => readonly RecordedAction[];

/** Keeps current rendered UI independent from the public REST journal reader. */
const renderedSources = new WeakMap<object, RenderedActionsReader>();

export function registerRenderedSource(source: object, readActions: RenderedActionsReader): void {
	renderedSources.set(source, readActions);
}

export function renderedActionsOf(source: unknown): readonly RecordedAction[] | undefined {
	if ((typeof source !== 'object' || source === null) && typeof source !== 'function') return undefined;
	return renderedSources.get(source as object)?.();
}
