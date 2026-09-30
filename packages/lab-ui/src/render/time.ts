/** The lab UI is English-only; dates must not follow the browser's locale. */
const LOCALE = 'en-US';

function parse(value: string | undefined): Date | undefined {
	const date = value ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** Date divider between messages from different days. */
export const dayLabel = (value?: string) =>
	parse(value)?.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });

/** Time beside the author, and in embed footers. */
export const messageTime = (value?: string) =>
	parse(value)?.toLocaleString(LOCALE, {
		day: '2-digit',
		month: '2-digit',
		year: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});

/** Time in the gutter of a message grouped under the previous one. */
export const gutterTime = (value?: string) =>
	parse(value)?.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });

const TIMESTAMP_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
	t: { timeStyle: 'short' },
	T: { timeStyle: 'medium' },
	d: { dateStyle: 'short' },
	D: { dateStyle: 'long' },
	f: { dateStyle: 'long', timeStyle: 'short' },
	F: { dateStyle: 'full', timeStyle: 'short' },
};

/** Markdown `<t:seconds:style>`; an out-of-range value stays as the literal seconds. */
export function markdownTimestamp(seconds: string, style = 'f'): { dateTime?: string; text: string } {
	const date = new Date(Number(seconds) * 1000);
	if (Number.isNaN(date.getTime())) return { text: seconds };
	const text =
		style === 'R'
			? new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' }).format(
					Math.round((date.getTime() - Date.now()) / 60_000),
					'minute',
				)
			: date.toLocaleString(LOCALE, TIMESTAMP_STYLES[style] ?? TIMESTAMP_STYLES.f);
	return { dateTime: date.toISOString(), text };
}
