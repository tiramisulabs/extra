export function freezeVoiceState<T extends object>(state: T): Readonly<T> {
	return deepFreeze(state, new WeakSet());
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	for (const nested of Object.values(value)) {
		deepFreeze(nested, seen);
	}

	return Object.freeze(value);
}
