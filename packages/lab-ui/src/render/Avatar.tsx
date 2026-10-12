import { useState } from 'react';
import { avatarUrl } from './cdn';

const INITIAL_COLORS = ['#5865f2', '#757e8a', '#3ba55c', '#faa61a', '#ed4245', '#eb459e'];
const SMALL_AVATAR = 32;

/** CDN avatar (custom or Discord's default for the ID); initials only when there is no usable ID or it fails. */
export function Avatar({
	name,
	user,
	size = 40,
}: {
	name: string;
	user?: { id?: string; avatar?: string | null };
	size?: number;
}) {
	const [failed, setFailed] = useState(false);
	const src = failed ? undefined : avatarUrl(user, size <= SMALL_AVATAR ? 64 : 128);
	if (src)
		return (
			<img
				className="avatar"
				src={src}
				alt=""
				width={size}
				height={size}
				draggable={false}
				onError={() => setFailed(true)}
			/>
		);
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (
		<span
			className="avatar"
			aria-hidden="true"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.42,
				background: INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length],
			}}>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}
