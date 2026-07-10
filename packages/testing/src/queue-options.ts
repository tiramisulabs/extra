export const queueAddAmbiguityMessage = [
	'Ambiguous queue.add() call: a string first argument plus an options-shaped second argument can be either data/options or name/data.',
	'Use add(name, data, options) for named jobs, or pass non-string data to add(data, options).',
].join(' ');

export const queueJobOptionKeys = ['id', 'delay', 'attempts', 'priority', 'retryDelay'] as const;
const queueJobOptionKeySet = new Set<string>(queueJobOptionKeys);

export function isJobOptionsLike(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every(key => queueJobOptionKeySet.has(key));
}

export function isAmbiguousQueueAddArgs(
	nameOrPayload: unknown,
	payloadOrOptions: unknown,
	maybeOptions: unknown,
): boolean {
	return (
		typeof nameOrPayload === 'string' &&
		payloadOrOptions !== undefined &&
		maybeOptions === undefined &&
		isJobOptionsLike(payloadOrOptions)
	);
}
