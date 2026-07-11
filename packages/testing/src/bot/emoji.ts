// Single source of truth for the reaction-emoji `name` / `name:id` convention shared by the REST path
// (defaults.ts), the world-state store (state.ts), and the gateway-event path (world-events.ts).

/** URL-decode a reaction emoji that arrives `%`-escaped on the REST route. Idempotent on already-decoded keys. */
export function decodeEmoji(emoji: string): string {
	if (!emoji.includes('%')) return emoji;
	try {
		return decodeURIComponent(emoji);
	} catch {
		return emoji;
	}
}

/** Split a reaction route's emoji segment (`name` unicode, or `name:id` custom) into a gateway emoji object. */
export function emojiPayload(emoji: string): { name: string; id: string | null } {
	const decoded = decodeEmoji(emoji);
	const colon = decoded.indexOf(':');
	return colon === -1 ? { name: decoded, id: null } : { name: decoded.slice(0, colon), id: decoded.slice(colon + 1) };
}

/** Reduce a gateway emoji object `{ name, id }` to the stable reaction-state key (`name`, or `name:id` for custom). */
export function emojiKey(emoji: unknown): string | undefined {
	if (typeof emoji !== 'object' || emoji === null) return undefined;
	const { name, id } = emoji as { name?: unknown; id?: unknown };
	if (typeof name !== 'string') return undefined;
	return typeof id === 'string' && id.length > 0 ? `${name}:${id}` : name;
}
