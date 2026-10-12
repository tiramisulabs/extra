import type { VisibleMessage } from '../bridge';
import { isEphemeral } from '../messages';

const GROUP_WINDOW_MS = 7 * 60_000;

/**
 * Discord groups a public message under the previous one from the same author within seven minutes.
 * Ephemeral responses always stand alone: each one belongs to its own interaction.
 */
export function continues(previous: VisibleMessage | undefined, message: VisibleMessage): boolean {
	if (!previous || isEphemeral(previous) || isEphemeral(message)) return false;
	if (!previous.payload.author?.id || previous.payload.author.id !== message.payload.author?.id) return false;
	const gap = Date.parse(message.payload.timestamp ?? '') - Date.parse(previous.payload.timestamp ?? '');
	return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS;
}
