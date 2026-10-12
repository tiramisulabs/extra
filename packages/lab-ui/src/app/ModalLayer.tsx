import { useEffect, useRef, useState } from 'react';
import type { Guild, ModalAttachment, PendingModal } from '../bridge';
import { Modal, type ModalValues } from '../render/Modal';

/**
 * The viewer's open modal, if any. What each open or closed modal holds is kept, as a Discord client keeps it,
 * until the form is sent or dismissed. An expired open form keeps its draft with an explicit notice.
 */
export function ModalLayer({
	uploadFiles,
	pending,
	closedModals,
	viewerId,
	onClose,
	onSubmit,
	guilds,
}: {
	uploadFiles?: (files: File[]) => Promise<ModalAttachment[]>;
	pending: PendingModal[];
	guilds?: Guild[];
	closedModals: string[];
	viewerId?: string;
	onClose: (customId: string) => void;
	onSubmit: (submission: { customId: string; fields: ModalValues }, channelId?: string) => void | Promise<void>;
}) {
	const drafts = useRef(new Map<string, ModalValues>());
	const [retained, setRetained] = useState<PendingModal>();
	const open = pending.find(item => item.userId === viewerId && !closedModals.includes(item.interactionId));
	useEffect(() => {
		if (open) setRetained(open);
	}, [open]);
	const pendingKeys = pending.map(item => item.interactionId).join('|');
	useEffect(() => {
		const live = new Set(pendingKeys.split('|').filter(Boolean));
		if (retained) live.add(retained.interactionId);
		for (const key of drafts.current.keys()) if (!live.has(key)) drafts.current.delete(key);
	}, [pendingKeys, retained]);

	const expiredCopy =
		retained && retained.userId === viewerId && !closedModals.includes(retained.interactionId) ? retained : undefined;
	const modal = open ?? expiredCopy;
	if (!modal) return null;
	return (
		<Modal
			uploadFiles={uploadFiles}
			key={modal.interactionId}
			modal={modal}
			expired={!pending.some(item => item.interactionId === modal.interactionId)}
			guild={guilds?.find(guild => guild.channels.some(channel => channel.id === modal.source?.channelId))}
			draft={drafts.current.get(modal.interactionId)}
			onDraft={values => drafts.current.set(modal.interactionId, values)}
			onClose={() => {
				setRetained(undefined);
				if (pending.some(item => item.interactionId === modal.interactionId)) onClose(modal.customId);
			}}
			// A reopened form belongs to the channel it was opened in, not the one on screen now.
			onSubmit={async submission => {
				await onSubmit(submission, modal.source?.channelId);
				setRetained(undefined);
				drafts.current.delete(modal.interactionId);
			}}
		/>
	);
}
