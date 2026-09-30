import { useState } from 'react';
import { emojiUrl } from './cdn';

/**
 * A custom emoji loaded from Discord's CDN, sized like the surface it sits in. The `:name:` text is only the
 * fallback for missing data or a failed load, never the primary rendering.
 */
export function Emoji({
	emoji,
	size = 'inline',
}: {
	emoji: { id?: string | null; name?: string | null; animated?: boolean };
	size?: 'inline' | 'jumbo' | 'button';
}) {
	const [failed, setFailed] = useState(false);
	const name = emoji.name ?? 'emoji';
	const src = emojiUrl(emoji, size === 'jumbo' ? 128 : 64);
	if (!emoji.id) return <span className={`unicode-emoji emoji--${size}`}>{emoji.name}</span>;
	if (!src || failed)
		return (
			<span className="custom-emoji-fallback" title={`:${name}:`}>
				:{name}:
			</span>
		);
	return (
		<img
			className={`emoji emoji--${size}`}
			src={src}
			alt={`:${name}:`}
			title={`:${name}:`}
			draggable={false}
			loading="lazy"
			onError={() => setFailed(true)}
		/>
	);
}
