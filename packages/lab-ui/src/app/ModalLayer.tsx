import { useEffect, useRef } from 'react';
import type { LabSnapshot } from '../bridge';
import { Modal, type ModalValues } from '../render/Modal';

/**
 * The viewer's open modal, if any. What each open or closed modal holds is kept, as a Discord client keeps it,
 * until the form is sent or the bot stops waiting for it.
 */
export function ModalLayer({
	pending,
	closedModals,
	viewerId,
	onClose,
	onSubmit,
}: {
	pending: LabSnapshot['pending']['modals'];
	closedModals: string[];
	viewerId?: string;
	onClose: (customId: string) => void;
	onSubmit: (submission: { customId: string; fields: ModalValues }, channelId?: string) => void;
}) {
	const drafts = useRef(new Map<string, ModalValues>());
	const pendingKeys = pending.map(item => item.interactionId).join('|');
	useEffect(() => {
		const live = new Set(pendingKeys.split('|'));
		for (const key of drafts.current.keys()) if (!live.has(key)) drafts.current.delete(key);
	}, [pendingKeys]);

	const modal = pending.find(item => item.userId === viewerId && !closedModals.includes(item.interactionId));
	if (!modal) return null;
	return (
		<Modal
			key={modal.interactionId}
			modal={modal}
			draft={drafts.current.get(modal.interactionId)}
			onDraft={values => drafts.current.set(modal.interactionId, values)}
			onClose={() => onClose(modal.customId)}
			// A reopened form belongs to the channel it was opened in, not the one on screen now.
			onSubmit={submission => onSubmit(submission, modal.source?.channelId)}
		/>
	);
}
