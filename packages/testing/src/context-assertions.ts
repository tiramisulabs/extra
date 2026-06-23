import { type ErrorMatcher, MockAssertionError } from './bot/assertions';
import { type EmbedView, type InteractiveComponentView, normalizeEmbed } from './bot/state';

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
	lastEmbeds?(): EmbedView[];
	embeds?: unknown;
}

function embedsOf(subject: EmbedSource): EmbedView[] {
	if (typeof subject.lastEmbeds === 'function') return subject.lastEmbeds();
	return (Array.isArray(subject.embeds) ? subject.embeds : []).map(normalizeEmbed);
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

const matchText = (value: unknown, matcher: string | RegExp): boolean => {
	const text = asText(value);
	return typeof matcher === 'string' ? text.includes(matcher) : matcher.test(text);
};

function embedText(embed: EmbedView): string {
	const parts = [
		asText(embed.title),
		asText(embed.description),
		asText(embed.author?.name),
		asText(embed.footer?.text),
	];
	for (const field of embed.fields) parts.push(asText(field.name), asText(field.value));
	return parts.join('\n');
}

function embedMatches(embed: EmbedView, expected: ExpectedEmbed): boolean {
	if (expected.title !== undefined && !matchText(embed.title, expected.title)) return false;
	if (expected.description !== undefined && !matchText(embed.description, expected.description)) return false;
	if (expected.url !== undefined && !matchText(embed.url, expected.url)) return false;
	if (expected.color !== undefined && embed.color !== expected.color) return false;
	if (expected.author !== undefined && !matchText(embed.author?.name, expected.author)) return false;
	if (expected.footer !== undefined && !matchText(embed.footer?.text, expected.footer)) return false;
	if (expected.contains !== undefined && !matchText(embedText(embed), expected.contains)) return false;
	if (expected.fieldsInclude) {
		for (const want of expected.fieldsInclude) {
			const hit = embed.fields.some(
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
export function expectEmbed(subject: EmbedSource, expected?: ExpectedEmbed): EmbedView {
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

/**
 * Anything that carries a last reply's text: a context fixture (via {@link lastResponse}) or a bot-path
 * `DispatchResult` (via its `content`). One matcher serves both response paths.
 */
export interface ContentSource {
	lastResponse?(): Record<string, unknown> | string | undefined;
	content?: string;
}

function contentOf(subject: ContentSource): string | undefined {
	if (typeof subject.lastResponse === 'function') {
		const last = subject.lastResponse();
		if (typeof last === 'string') return last;
		const content = (last as { content?: unknown } | undefined)?.content;
		return typeof content === 'string' ? content : undefined;
	}
	return typeof subject.content === 'string' ? subject.content : undefined;
}

const matchesContent = (content: string, matcher: ErrorMatcher): boolean => {
	if (typeof matcher === 'function') return matcher(content);
	return typeof matcher === 'string' ? content.includes(matcher) : matcher.test(content);
};

/**
 * Assert the last reply's `content` matches the substring / RegExp / predicate. Throws when no reply was sent
 * or it carried no `content`, so it can't pass vacuously the way `expect(lastResponse()?.content).toContain(x)`
 * does when `content` is `undefined`. Works on a mock context fixture and a bot-path `DispatchResult`. Returns
 * the matched content for chaining. (Unlike embeds, `content` is always a plain string — no builder footgun —
 * so the value here is purely the anti-vacuous guard + shared vocabulary.)
 */
export function expectContent(subject: ContentSource, matcher: ErrorMatcher): string {
	const content = contentOf(subject);
	if (content === undefined) {
		throw new MockAssertionError('expectContent: no reply with content was sent.');
	}
	if (!matchesContent(content, matcher)) {
		throw new MockAssertionError(`expectContent: content did not match — got ${JSON.stringify(content)}.`);
	}
	return content;
}

/**
 * Expected-component shape for {@link expectComponent}; every field is optional and checked only when present.
 */
export interface ExpectedComponent {
	customId?: string | RegExp;
	label?: string | RegExp;
	/** `'button'` (type 2), `'select'` (type 3 or 5–8), or a raw numeric component type for an exact match. */
	type?: 'button' | 'select' | number;
	disabled?: boolean;
	/** Each entry must match at least one of the component's select options (by label and/or value). */
	options?: { label?: string | RegExp; value?: string | RegExp }[];
}

/**
 * Anything that carries interactive components: a mock context fixture (via its flattened {@link lastComponents})
 * or a bot-path `DispatchResult` (via its already-normalized `components`). One matcher serves both paths.
 */
export interface ComponentSource {
	lastComponents?(): InteractiveComponentView[];
	components?: unknown;
}

function componentsOf(subject: ComponentSource): InteractiveComponentView[] {
	if (typeof subject.lastComponents === 'function') return subject.lastComponents();
	return Array.isArray(subject.components) ? (subject.components as InteractiveComponentView[]) : [];
}

const isSelectType = (type: number): boolean => type === 3 || (type >= 5 && type <= 8);

function componentMatches(component: InteractiveComponentView, expected: ExpectedComponent): boolean {
	if (expected.customId !== undefined && !matchText(component.customId, expected.customId)) return false;
	if (expected.label !== undefined && !matchText(component.label, expected.label)) return false;
	if (expected.type !== undefined) {
		if (typeof expected.type === 'number') {
			if (component.type !== expected.type) return false;
		} else if (expected.type === 'button') {
			if (component.type !== 2) return false;
		} else if (!isSelectType(component.type)) {
			return false;
		}
	}
	if (expected.disabled !== undefined && (component.disabled ?? false) !== expected.disabled) return false;
	if (expected.options) {
		const options = component.options ?? [];
		for (const want of expected.options) {
			const hit = options.some(
				option =>
					(want.label === undefined || matchText(option.label, want.label)) &&
					(want.value === undefined || matchText(option.value, want.value)),
			);
			if (!hit) return false;
		}
	}
	return true;
}

/**
 * Assert that a reply rendered an interactive component (button/select) — and, with `expected`, that one of
 * them matches the given fields (customId/label/type/disabled/options). Works on a mock context fixture and a
 * bot-path `DispatchResult`. Throws when no component was sent or none matches, so it can't pass vacuously the
 * way reading `lastResponse().components[0].components[0].custom_id` (a builder field under `.toJSON()`) does.
 * Returns the matched component (normalized) for further assertions.
 */
export function expectComponent(subject: ComponentSource, expected?: ExpectedComponent): InteractiveComponentView {
	const components = componentsOf(subject);
	if (components.length === 0) {
		throw new MockAssertionError('expectComponent: no interactive component was sent.');
	}
	if (!expected) return components[0];
	const match = components.find(component => componentMatches(component, expected));
	if (!match) {
		throw new MockAssertionError(
			`expectComponent: no component matched ${JSON.stringify(expected)}. Components sent: ${JSON.stringify(components)}.`,
		);
	}
	return match;
}
