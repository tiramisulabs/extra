import type { ReactNode } from 'react';
import { Emoji } from './Emoji';
import { markdownTimestamp } from './time';

export interface NameMap {
	users?: Record<string, string>;
	roles?: Record<string, string>;
	channels?: Record<string, string>;
}

/**
 * The subset of Discord markdown a bot author commonly uses. Anything else stays literal text, which is what
 * Discord does too for syntax it does not recognise.
 */
const INLINE = new RegExp(
	[
		'(?<code>`[^`\\n]+`)',
		'(?<link>\\[(?<linkText>[^\\]\\n]+)\\]\\((?<linkUrl>https?:\\/\\/[^)\\s]+)\\))',
		'(?<bold>\\*\\*(?<boldText>.+?)\\*\\*)',
		'(?<underline>__(?<underlineText>.+?)__)',
		'(?<italic>\\*(?<italicText>[^*\\n]+)\\*|(?<![\\w])_(?<italicUnderscore>[^_\\n]+)_(?![\\w]))',
		'(?<strike>~~(?<strikeText>.+?)~~)',
		'(?<spoiler>\\|\\|(?<spoilerText>.+?)\\|\\|)',
		'(?<emoji><(?<emojiAnimated>a?):(?<emojiName>\\w+):(?<emojiId>\\d{17,20})>)',
		'(?<mention><(?<mentionKind>@!?|@&|#)(?<mentionId>\\d+)>)',
		'(?<time><t:(?<timeValue>-?\\d+)(?::(?<timeStyle>[tTdDfFR]))?>)',
		'(?<url>https?:\\/\\/[^\\s<]+[^\\s<.,:;"\')\\]])',
	].join('|'),
	'g',
);

function inline(value: string, names: NameMap, jumbo = false): ReactNode[] {
	const nodes: ReactNode[] = [];
	let last = 0;
	for (const match of value.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > last) nodes.push(value.slice(last, index));
		const group = match.groups ?? {};
		const key = `${index}`;
		if (group.code) nodes.push(<code key={key}>{group.code.slice(1, -1)}</code>);
		else if (group.link)
			nodes.push(
				<a key={key} href={group.linkUrl} target="_blank" rel="noreferrer">
					{inline(group.linkText, names)}
				</a>,
			);
		else if (group.bold) nodes.push(<strong key={key}>{inline(group.boldText, names)}</strong>);
		else if (group.underline) nodes.push(<u key={key}>{inline(group.underlineText, names)}</u>);
		else if (group.italic) nodes.push(<em key={key}>{inline(group.italicText ?? group.italicUnderscore, names)}</em>);
		else if (group.strike) nodes.push(<s key={key}>{inline(group.strikeText, names)}</s>);
		else if (group.spoiler)
			nodes.push(
				<span key={key} className="spoiler" title="Spoiler">
					{inline(group.spoilerText, names)}
				</span>,
			);
		else if (group.emoji)
			nodes.push(
				<Emoji
					key={key}
					emoji={{ id: group.emojiId, name: group.emojiName, animated: group.emojiAnimated === 'a' }}
					size={jumbo ? 'jumbo' : 'inline'}
				/>,
			);
		else if (group.mention) {
			const kind = group.mentionKind;
			const id = group.mentionId;
			const name = kind === '#' ? names.channels?.[id] : kind === '@&' ? names.roles?.[id] : names.users?.[id];
			nodes.push(
				<span className="mention" key={key}>
					{kind === '#' ? '#' : '@'}
					{name ?? id}
				</span>,
			);
		} else if (group.time) {
			const time = markdownTimestamp(group.timeValue, group.timeStyle);
			nodes.push(
				<time key={key} className="timestamp" dateTime={time.dateTime}>
					{time.text}
				</time>,
			);
		} else if (group.url)
			nodes.push(
				<a key={key} href={group.url} target="_blank" rel="noreferrer">
					{group.url}
				</a>,
			);
		last = index + match[0].length;
	}
	if (last < value.length) nodes.push(value.slice(last));
	return nodes;
}

type Block =
	| { kind: 'heading'; level: 1 | 2 | 3; text: string }
	| { kind: 'subtext' | 'line'; text: string }
	| { kind: 'quote'; lines: string[] }
	| { kind: 'list'; ordered: boolean; items: string[] };

function blocks(text: string): Block[] {
	const result: Block[] = [];
	for (const line of text.split('\n')) {
		const heading = /^(#{1,3}) (.+)$/.exec(line);
		const quote = /^> ?(.*)$/.exec(line);
		const bullet = /^\s*[-*] (.+)$/.exec(line);
		const numbered = /^\s*\d+\. (.+)$/.exec(line);
		const previous = result.at(-1);
		if (heading) result.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
		else if (line.startsWith('-# ')) result.push({ kind: 'subtext', text: line.slice(3) });
		else if (quote) {
			if (previous?.kind === 'quote') previous.lines.push(quote[1]);
			else result.push({ kind: 'quote', lines: [quote[1]] });
		} else if (bullet || numbered) {
			const ordered = Boolean(numbered);
			const item = (bullet ?? numbered)?.[1] ?? '';
			if (previous?.kind === 'list' && previous.ordered === ordered) previous.items.push(item);
			else result.push({ kind: 'list', ordered, items: [item] });
		} else result.push({ kind: 'line', text: line });
	}
	return result;
}

function renderBlocks(text: string, names: NameMap, prefix: string, jumbo = false): ReactNode[] {
	return blocks(text).map((block, index) => {
		const key = `${prefix}-${index}`;
		switch (block.kind) {
			case 'heading': {
				const Tag = `h${block.level}` as const;
				return (
					<Tag key={key} className="md-heading">
						{inline(block.text, names)}
					</Tag>
				);
			}
			case 'subtext':
				return (
					<small key={key} className="md-subtext">
						{inline(block.text, names)}
					</small>
				);
			case 'quote':
				return (
					<blockquote key={key} className="md-quote">
						{renderBlocks(block.lines.join('\n'), names, key)}
					</blockquote>
				);
			case 'list': {
				const List = block.ordered ? 'ol' : 'ul';
				return (
					<List key={key} className="md-list">
						{block.items.map((item, itemIndex) => (
							<li key={itemIndex}>{inline(item, names)}</li>
						))}
					</List>
				);
			}
			default:
				return block.text ? (
					<p key={key} className="md-line">
						{inline(block.text, names, jumbo)}
					</p>
				) : (
					<br key={key} />
				);
		}
	});
}

/** Discord enlarges messages made only of emojis (up to 27). */
const EMOJI_ONLY = /^(?:\s*(?:<a?:\w+:\d{17,20}>|\p{Extended_Pictographic}\uFE0F?))+\s*$/u;
const emojiCount = (text: string) => (text.match(/<a?:\w+:\d{17,20}>|\p{Extended_Pictographic}/gu) ?? []).length;

export function Markdown({
	text,
	names = {},
	jumboAllowed = false,
}: {
	text: string;
	names?: NameMap;
	jumboAllowed?: boolean;
}) {
	const jumbo = jumboAllowed && EMOJI_ONLY.test(text) && emojiCount(text) <= 27;
	return (
		<div className="markdown">
			{text.split(/(```[\s\S]*?```)/g).map((part, index) =>
				part.startsWith('```') && part.endsWith('```') && part.length >= 6 ? (
					<pre key={index}>
						<code>{part.slice(3, -3).replace(/^\w*\n/, '')}</code>
					</pre>
				) : (
					renderBlocks(part.replace(/^\n|\n$/g, ''), names, `${index}`, jumbo)
				),
			)}
		</div>
	);
}

/** Emoji attached to a button or select option: custom ones come from the CDN, unicode ones render as text. */
export function EmojiLabel({ emoji }: { emoji: { name?: string; id?: string; animated?: boolean } }) {
	if (!emoji.name && !emoji.id) return null;
	return <Emoji emoji={emoji} size="button" />;
}
