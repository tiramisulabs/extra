import { type ReactNode, useState } from 'react';
import type { Guild, MessageIntent, MessagePayload, VisibleMessage } from '../bridge';
import { EyeIcon } from '../icons';
import { isComponentsV2, isEphemeral, LOADING_FLAG } from '../messages';
import { Avatar } from './Avatar';
import { Component, hex } from './Component';
import { mediaUrl } from './cdn';
import { Markdown, type NameMap } from './Markdown';
import { Attachment, MediaImage, referencedMediaUrl } from './Media';
import { gutterTime, messageTime } from './time';

type Embed = NonNullable<MessagePayload['embeds']>[number];

/** Small round icon (embed author/footer); hidden if it cannot load, as Discord does. */
function EmbedIcon({ url }: { url?: string }) {
	const [failed, setFailed] = useState(false);
	const src = mediaUrl(url);
	return src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : null;
}

function MessageEmbed({
	embed,
	names,
	attachments,
}: {
	embed: Embed;
	names?: NameMap;
	attachments?: MessagePayload['attachments'];
}) {
	const title = embed.title && <Markdown text={embed.title} names={names} />;
	return (
		<div className={`embed ${embed.thumbnail ? 'with-thumbnail' : ''}`} style={{ borderLeftColor: hex(embed.color) }}>
			<div className="embed-grid">
				{embed.author && (
					<div className="embed-author">
						<EmbedIcon url={embed.author.icon_url} />
						{embed.author.url ? (
							<a href={embed.author.url} target="_blank" rel="noreferrer">
								{embed.author.name}
							</a>
						) : (
							<span>{embed.author.name}</span>
						)}
					</div>
				)}
				{title && (
					<div className="embed-title">
						{embed.url ? (
							<a href={embed.url} target="_blank" rel="noreferrer">
								{title}
							</a>
						) : (
							title
						)}
					</div>
				)}
				{embed.description && (
					<div className="embed-description">
						<Markdown text={embed.description} names={names} />
					</div>
				)}
				{embed.fields && embed.fields.length > 0 && (
					<div className="embed-fields">
						{embed.fields.map((field, index) => (
							<div key={index} className={`embed-field ${field.inline ? 'inline' : ''}`}>
								<div className="embed-field-name">
									<Markdown text={field.name} names={names} />
								</div>
								<div className="embed-field-value">
									<Markdown text={field.value} names={names} />
								</div>
							</div>
						))}
					</div>
				)}
				{embed.image && (
					<MediaImage
						key={embed.image.url}
						url={referencedMediaUrl(embed.image.url, attachments)}
						className="embed-image"
					/>
				)}
				{(embed.footer || embed.timestamp) && (
					<div className="embed-footer">
						<EmbedIcon url={embed.footer?.icon_url} />
						<span>
							{embed.footer?.text}
							{embed.footer && embed.timestamp && ' • '}
							{messageTime(embed.timestamp)}
						</span>
					</div>
				)}
			</div>
			{embed.thumbnail && (
				<MediaImage
					key={embed.thumbnail.url}
					url={referencedMediaUrl(embed.thumbnail.url, attachments)}
					className="embed-thumbnail"
				/>
			)}
		</div>
	);
}

export function Message({
	message,
	onIntent,
	names,
	guild,
	tools,
	onDismiss,
	continued = false,
}: {
	message: VisibleMessage;
	onIntent: (intent: MessageIntent) => void | Promise<void>;
	names?: NameMap;
	guild?: Guild;
	tools?: ReactNode;
	/** Present for the viewer's own ephemeral messages, which Discord lets them dismiss. */
	onDismiss?: () => void;
	/** Same author shortly after the previous message: Discord drops the avatar and header. */
	continued?: boolean;
}) {
	const payload = message.payload;
	const author = payload.author?.global_name ?? payload.author?.username ?? 'Bot';
	const ephemeral = isEphemeral(message);
	const thinking = Boolean((payload.flags ?? 0) & LOADING_FLAG);
	const v2 = isComponentsV2(payload.flags);
	const plainOnly = !payload.embeds?.length && !payload.components?.length && !payload.attachments?.length;
	const sentAt = messageTime(payload.timestamp);
	return (
		<article
			className={`message ${ephemeral ? 'ephemeral' : ''} ${continued ? 'continued' : ''}`}
			data-message-id={message.id}>
			{continued ? (
				<time className="gutter-time" dateTime={payload.timestamp}>
					{gutterTime(payload.timestamp)}
				</time>
			) : (
				<Avatar name={author} user={payload.author} />
			)}
			<div className="message-body">
				{!continued && (
					<header className="message-meta">
						<strong className="author">{author}</strong>
						{payload.author?.bot && <span className="bot-tag">APP</span>}
						{sentAt && <time dateTime={payload.timestamp}>{sentAt}</time>}
					</header>
				)}
				{thinking ? (
					<p className="thinking">
						<span aria-hidden="true" className="dots">
							<i />
							<i />
							<i />
						</span>
						{author} is thinking…
					</p>
				) : (
					!v2 &&
					payload.content && (
						<div className="message-content">
							<Markdown text={payload.content} names={names} jumboAllowed={plainOnly} />
							{message.editedAt && <span className="edited">(edited)</span>}
						</div>
					)
				)}
				{!payload.content && message.editedAt && <span className="edited">(edited)</span>}
				{!v2 &&
					payload.attachments?.map(attachment => (
						<Attachment key={`${attachment.id}:${attachment.url}`} attachment={attachment} />
					))}
				{!v2 &&
					payload.embeds?.map((embed, index) => (
						<MessageEmbed key={index} embed={embed} names={names} attachments={payload.attachments} />
					))}
				{payload.components?.map((component, index) => (
					<Component
						key={component.id ?? index}
						component={component}
						messageId={message.id}
						onIntent={onIntent}
						names={names}
						guild={guild}
						attachments={payload.attachments}
					/>
				))}
				{ephemeral && (
					<p className="ephemeral-note">
						<EyeIcon size={16} />
						<span>Only you can see this</span>
						{onDismiss && (
							<>
								<span aria-hidden="true">·</span>
								<button type="button" className="text-link" onClick={onDismiss}>
									Dismiss message
								</button>
							</>
						)}
					</p>
				)}
			</div>
			{tools && <div className="message-tools">{tools}</div>}
		</article>
	);
}
