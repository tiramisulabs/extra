import type { VisibleMessage } from '../bridge';

const EPHEMERAL = 64;

/** Same rule the message renderer uses to show "Only you can see this". */
export const isEphemeral = (message: VisibleMessage) =>
	message.visibility === 'ephemeral' || Boolean((message.payload.flags ?? 0) & EPHEMERAL);

/**
 * Discord groups a public message under the previous one from the same author within seven minutes.
 * Ephemeral responses always stand alone: each one belongs to its own interaction.
 */
export function continues(previous: VisibleMessage | undefined, message: VisibleMessage): boolean {
	if (!previous || isEphemeral(previous) || isEphemeral(message)) return false;
	if (!previous.payload.author?.id || previous.payload.author.id !== message.payload.author?.id) return false;
	const gap = Date.parse(message.payload.timestamp ?? '') - Date.parse(previous.payload.timestamp ?? '');
	return Number.isFinite(gap) && gap >= 0 && gap < 7 * 60_000;
}
