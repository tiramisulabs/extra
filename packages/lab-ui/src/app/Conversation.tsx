import { Fragment, useLayoutEffect, useRef } from 'react';
import type { Expectation, LabClient, MessageIntent, VisibleMessage } from '../bridge';
import { LockedHashIcon, PinIcon } from '../icons';
import { messageText } from '../messages';
import { continues } from '../render/grouping';
import type { NameMap } from '../render/Markdown';
import { Message } from '../render/Message';
import { dayLabel } from '../render/time';

/** Distance from the bottom, in pixels, within which the reader still counts as at the end. */
const FOLLOW_THRESHOLD = 80;

/** Keeps the list scrolled to new messages only while the reader is already at the end, like Discord does. */
function useFollowNewMessages(viewKey: string, messages: VisibleMessage[]) {
	const list = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const signature = messages.map(item => `${item.id}:${item.editedAt ?? ''}`).join('|');
	useLayoutEffect(() => {
		following.current = true;
	}, [viewKey]);
	useLayoutEffect(() => {
		const element = list.current;
		if (element && following.current && signature) element.scrollTop = element.scrollHeight;
	}, [signature, viewKey]);
	const onScroll = () => {
		const element = list.current;
		if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_THRESHOLD;
	};
	return { list, onScroll };
}

/** One actor's view of one channel: its messages, or the lock screen when the actor cannot view it. */
export function Conversation({
	client,
	actor,
	channel,
	channelName,
	viewerId,
	canView,
	messages,
	names,
	onIntent,
	onPin,
	report,
}: {
	client: LabClient;
	actor: string;
	channel: string;
	channelName: string;
	viewerId?: string;
	canView: boolean;
	messages: VisibleMessage[];
	names?: NameMap;
	onIntent: (intent: MessageIntent) => void;
	/** Present when the client can save checkpoints. */
	onPin?: (expectation: Expectation) => void;
	report: (reason: unknown) => void;
}) {
	const { list, onScroll } = useFollowNewMessages(`${actor}:${channel}`, messages);
	return (
		<div className="messages" data-testid="conversation" aria-live="polite" ref={list} onScroll={onScroll}>
			{canView ? (
				!messages.length && <p className="channel-empty">No messages</p>
			) : (
				<div className="no-access">
					<LockedHashIcon size={48} />
					<h2>No access to #{channelName}</h2>
				</div>
			)}
			{messages.map((item, index) => {
				const text = messageText(item.payload);
				const previous = messages[index - 1];
				const day = dayLabel(item.payload.timestamp);
				const newDay = day && day !== dayLabel(previous?.payload.timestamp);
				const dismissible = item.visibility === 'ephemeral' && item.ownerId === viewerId;
				return (
					<Fragment key={item.id}>
						{newDay && (
							<div className="date-divider" role="separator">
								<span>{day}</span>
							</div>
						)}
						<Message
							message={item}
							names={names}
							onIntent={onIntent}
							onDismiss={dismissible ? () => void client.dismissMessage(actor, channel, item).catch(report) : undefined}
							continued={!newDay && continues(previous, item)}
							tools={
								onPin &&
								text && (
									<button
										type="button"
										className="lab-mini"
										title="Expect this message"
										aria-label="Expect this message to be visible"
										onClick={() => onPin({ view: { actor, channel }, contains: text })}>
										<PinIcon />
									</button>
								)
							}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}
