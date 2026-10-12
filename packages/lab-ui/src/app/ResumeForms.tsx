import type { PendingModal, VisibleMessage } from '../bridge';
import { componentTree } from '../messages';

/**
 * Closed forms the bot still waits for, whose trigger is not on screen (dismissed, hidden or elsewhere).
 * Without this the actor could only wait for the bot's timeout.
 */
export function unreachableForms(
	modals: PendingModal[],
	closed: string[],
	viewerId: string | undefined,
	visible: VisibleMessage[],
): PendingModal[] {
	return modals.filter(
		item =>
			item.userId === viewerId &&
			closed.includes(item.interactionId) &&
			!visible.some(message => message.id === item.source?.messageId && hasLiveTrigger(message, item.source.customId)),
	);
}

/** The trigger only counts while its component is still rendered and enabled on the message. */
function hasLiveTrigger(message: VisibleMessage, customId: string | undefined): boolean {
	if (!customId) return false;
	for (const component of componentTree(message.payload.components))
		if (component.custom_id === customId) return !component.disabled;
	return false;
}

export function ResumeForms({ forms, onReopen }: { forms: PendingModal[]; onReopen: (key: string) => void }) {
	if (!forms.length) return null;
	return (
		<div className="resume-forms">
			{forms.map(form => (
				<div className="resume-form" key={form.interactionId}>
					<span>
						Unsent form <strong>{form.payload.title}</strong>
					</span>
					<button type="button" className="text-link" onClick={() => onReopen(form.interactionId)}>
						Reopen
					</button>
				</div>
			))}
		</div>
	);
}
