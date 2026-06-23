import { MockAssertionError } from './bot/assertions';

/**
 * Expected-embed shape for {@link expectEmbed}; every field is optional and checked only when present. Text
 * fields take a substring or a RegExp, mirroring {@link ErrorMatcher}.
 */
export interface ExpectedEmbed {
	title?: string | RegExp;
	description?: string | RegExp;
	url?: string | RegExp;
	color?: number;
	/** Matches the author's `name`. */
	author?: string | RegExp;
	/** Matches the footer's `text`. */
	footer?: string | RegExp;
	/** Matches across title + description + author + footer + every field name/value (the safe stringify). */
	contains?: string | RegExp;
	/** Field name/value matchers; each entry must match at least one of the embed's fields. */
	fieldsInclude?: { name?: string | RegExp; value?: string | RegExp }[];
}

/**
 * Anything that carries embeds: a mock context fixture (via its normalized {@link lastEmbeds}) or a bot-path
 * `DispatchResult` (via its raw `embeds`). One matcher serves both response paths.
 */
export interface EmbedSource {
	lastEmbeds?(): Record<string, unknown>[];
	embeds?: unknown;
}

function normalizeEmbed(value: unknown): Record<string, unknown> {
	if (value && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return (value as { toJSON(): Record<string, unknown> }).toJSON();
	}
	return value as Record<string, unknown>;
}

function embedsOf(subject: EmbedSource): Record<string, unknown>[] {
	if (typeof subject.lastEmbeds === 'function') return subject.lastEmbeds();
	return (Array.isArray(subject.embeds) ? subject.embeds : []).map(normalizeEmbed);
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

const matchText = (value: unknown, matcher: string | RegExp): boolean => {
	const text = asText(value);
	return typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text);
};

function embedText(embed: Record<string, unknown>): string {
	const parts = [asText(embed.title), asText(embed.description)];
	parts.push(asText((embed.author as { name?: unknown } | undefined)?.name));
	parts.push(asText((embed.footer as { text?: unknown } | undefined)?.text));
	for (const field of (embed.fields as { name?: unknown; value?: unknown }[] | undefined) ?? []) {
		parts.push(asText(field.name), asText(field.value));
	}
	return parts.join('\n');
}

function embedMatches(embed: Record<string, unknown>, expected: ExpectedEmbed): boolean {
	if (expected.title !== undefined && !matchText(embed.title, expected.title)) return false;
	if (expected.description !== undefined && !matchText(embed.description, expected.description)) return false;
	if (expected.url !== undefined && !matchText(embed.url, expected.url)) return false;
	if (expected.color !== undefined && embed.color !== expected.color) return false;
	if (
		expected.author !== undefined &&
		!matchText((embed.author as { name?: unknown } | undefined)?.name, expected.author)
	)
		return false;
	if (
		expected.footer !== undefined &&
		!matchText((embed.footer as { text?: unknown } | undefined)?.text, expected.footer)
	)
		return false;
	if (expected.contains !== undefined && !matchText(embedText(embed), expected.contains)) return false;
	if (expected.fieldsInclude) {
		const fields = (embed.fields as { name?: unknown; value?: unknown }[] | undefined) ?? [];
		for (const want of expected.fieldsInclude) {
			const hit = fields.some(
				field =>
					(want.name === undefined || matchText(field.name, want.name)) &&
					(want.value === undefined || matchText(field.value, want.value)),
			);
			if (!hit) return false;
		}
	}
	return true;
}

/**
 * Assert that a reply carried an embed — and, with `expected`, that one of its embeds matches the given
 * normalized fields. Works on both a mock context fixture (`mockCommandContext`/component/modal) and a bot-path
 * `DispatchResult`. Throws when no embed was sent or none matches, so it cannot pass vacuously the way reading
 * `lastResponse().embeds[0].description` (an `Embed` builder field that lives under `.toJSON()`) does. Returns
 * the matched embed (normalized) for further assertions.
 */
export function expectEmbed(subject: EmbedSource, expected?: ExpectedEmbed): Record<string, unknown> {
	const embeds = embedsOf(subject);
	if (embeds.length === 0) {
		throw new MockAssertionError('expectEmbed: no embed was sent.');
	}
	if (!expected) return embeds[0];
	const match = embeds.find(embed => embedMatches(embed, expected));
	if (!match) {
		throw new MockAssertionError(
			`expectEmbed: no embed matched ${JSON.stringify(expected)}. Embeds sent: ${JSON.stringify(embeds)}.`,
		);
	}
	return match;
}
