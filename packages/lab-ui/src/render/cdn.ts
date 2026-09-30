/**
 * Discord CDN URLs for the public assets a payload already references (custom emojis, avatars).
 * Formats follow https://github.com/discord/discord-api-docs/blob/main/developers/reference.mdx#image-formatting:
 * WebP for static and animated images (`animated=true`), power-of-two sizes. Every value placed in a URL is
 * validated first; anything else yields `undefined` and the caller shows its fallback.
 */
const CDN = 'https://cdn.discordapp.com';
const SNOWFLAKE = /^\d{17,20}$/;
const IMAGE_HASH = /^(a_)?[0-9a-f]{32}$/;

type CdnSize = 64 | 128;

const isSnowflake = (value: unknown): value is string => typeof value === 'string' && SNOWFLAKE.test(value);

export function emojiUrl(emoji: { id?: string | null; animated?: boolean }, size: CdnSize = 64): string | undefined {
	if (!isSnowflake(emoji.id)) return undefined;
	return `${CDN}/emojis/${emoji.id}.webp?size=${size}${emoji.animated ? '&animated=true' : ''}`;
}

/** Custom avatar when the user has one, otherwise the default avatar Discord derives from the user ID. */
export function avatarUrl(
	user: { id?: string; avatar?: string | null } | undefined,
	size: CdnSize = 128,
): string | undefined {
	if (!user || !isSnowflake(user.id)) return undefined;
	if (typeof user.avatar === 'string' && IMAGE_HASH.test(user.avatar))
		return `${CDN}/avatars/${user.id}/${user.avatar}.webp?size=${size}${user.avatar.startsWith('a_') ? '&animated=true' : ''}`;
	return `${CDN}/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

/** Images and icons a payload links directly (embed thumbnails, footers…): any well-formed HTTPS URL. */
export function mediaUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}
