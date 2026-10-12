import { useState } from 'react';
import type { AttachmentPayload } from '../bridge';
import { referencedAttachment } from '../messages';
import { mediaUrl } from './cdn';

/** Linked image with a visible placeholder when the URL is unusable or fails to load. */
export function MediaImage({ url, className, alt = '' }: { url: string; className: string; alt?: string }) {
	const [failed, setFailed] = useState(false);
	const src = mediaUrl(url);
	return src && !failed ? (
		<img className={className} src={src} alt={alt} onError={() => setFailed(true)} />
	) : (
		<div className={`media-placeholder ${className}`}>{url}</div>
	);
}

/** Attachments remain visible even when this offline fixture has no downloadable bytes. */
export function Attachment({ attachment }: { attachment: AttachmentPayload }) {
	const spoiler = attachment.filename.startsWith('SPOILER_');
	const [revealed, setRevealed] = useState(false);
	const filename = spoiler ? attachment.filename.slice('SPOILER_'.length) : attachment.filename;
	if (spoiler && !revealed)
		return (
			<button type="button" className="attachment-spoiler" onClick={() => setRevealed(true)}>
				Reveal spoiler attachment
			</button>
		);
	const url = mediaUrl(attachment.url);
	const image = attachment.content_type?.startsWith('image/') || (attachment.width && attachment.height);
	return (
		<div className="attachment">
			{image && (
				<MediaImage
					key={attachment.url}
					url={attachment.url}
					className="attachment-image"
					alt={attachment.description ?? filename}
				/>
			)}
			<div className="attachment-details">
				{url ? (
					<a href={url} target="_blank" rel="noreferrer">
						{filename}
					</a>
				) : (
					<span>{filename}</span>
				)}
				{attachment.size !== undefined && <small>{attachment.size.toLocaleString()} bytes</small>}
				{!url && <small>File preview unavailable</small>}
			</div>
		</div>
	);
}

/** Resolved attachment URL, or the original URL when it is not an attachment reference. */
export const referencedMediaUrl = (url: string, attachments?: AttachmentPayload[]): string =>
	referencedAttachment(url, attachments)?.url ?? url;
