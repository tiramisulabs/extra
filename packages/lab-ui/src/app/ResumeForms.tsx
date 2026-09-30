import type { PendingModal, VisibleMessage } from '../bridge';

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
	const stack = [...(message.payload.components ?? [])];
	while (stack.length) {
		const component = stack.shift();
		if (!component) continue;
		if (component.custom_id === customId) return !component.disabled;
		stack.push(...(component.components ?? []), ...(component.accessory ? [component.accessory] : []));
	}
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
