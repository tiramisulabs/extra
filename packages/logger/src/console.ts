import type { LogEntry, LoggerAdapter, WritableLogLevel } from './core';
import { getString, stripUndefined } from './utils';

const RESET = '\x1b[0m';

const COLOR = {
	time: '\x1b[38;5;245m', // light-medium gray, readable (not dim)
	tag: '\x1b[38;5;110m', // soft steel blue
	key: '\x1b[38;5;73m', // muted teal for field keys
	error: '\x1b[1;38;5;203m', // bold salmon red
	warn: '\x1b[1;38;5;215m', // bold amber
	info: '\x1b[1;38;5;75m', // bold sky blue
	debug: '\x1b[38;5;141m', // soft violet
	trace: '\x1b[38;5;244m', // gray
} as const;

export class ConsoleLoggerAdapter implements LoggerAdapter {
	write(entry: LogEntry): void {
		const writer = getConsoleWriter(entry.level);

		if (process.env.NODE_ENV === 'production') {
			writer(
				JSON.stringify(
					stripUndefined({
						time: entry.time.toISOString(),
						level: entry.level,
						message: entry.message,
						...entry.bindings,
						...entry.data,
					}),
					jsonErrorReplacer,
				),
			);
			return;
		}

		writer(formatConsolePayload(entry));
	}
}

function consoleColorEnabled(): boolean {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(process.stdout?.isTTY);
}

function levelAnsiColor(level: WritableLogLevel): string {
	switch (level) {
		case 'error':
		case 'fatal':
			return COLOR.error;
		case 'warn':
			return COLOR.warn;
		case 'info':
			return COLOR.info;
		case 'debug':
			return COLOR.debug;
		default:
			return COLOR.trace;
	}
}

function paint(text: string, color: string, enabled: boolean): string {
	return enabled ? `${color}${text}${RESET}` : text;
}

function formatConsolePayload(entry: LogEntry): string {
	const enabled = consoleColorEnabled();
	const fields = stripUndefined({ ...entry.bindings, ...entry.data });
	const levelText = getString(fields.level) ?? entry.level;
	const messageText = getString(fields.message) ?? entry.message;
	const tag = getString(fields._source) ?? getString(fields.name);
	for (const key of ['level', 'message', 'time', '_source', 'name']) delete fields[key];

	const errors: Error[] = [];
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		if (value instanceof Error) {
			errors.push(value);
			delete fields[key];
		}
	}

	const head = [
		paint(formatConsoleTime(entry.time), COLOR.time, enabled),
		paint(levelText.toUpperCase().padEnd(5), levelAnsiColor(entry.level), enabled),
		tag ? paint(`[${tag}]`, COLOR.tag, enabled) : undefined,
		messageText,
	]
		.filter(Boolean)
		.join(' ');

	const lines = [head];
	const keys = Object.keys(fields);
	if (keys.length) {
		const width = Math.max(...keys.map(key => key.length)) + 3;
		for (const key of keys) {
			const gap = ' '.repeat(width - key.length);
			lines.push(`    ${paint(key, COLOR.key, enabled)}${gap}${formatConsoleFieldValue(key, fields[key])}`);
		}
	}
	for (const error of errors) lines.push(formatConsoleError(error, enabled));

	return lines.join('\n');
}

function formatConsoleTime(time: Date): string {
	const hours = String(time.getUTCHours()).padStart(2, '0');
	const minutes = String(time.getUTCMinutes()).padStart(2, '0');
	const seconds = String(time.getUTCSeconds()).padStart(2, '0');
	const millis = String(time.getUTCMilliseconds()).padStart(3, '0');
	return `${hours}:${minutes}:${seconds}.${millis}`;
}

function formatConsoleFieldValue(key: string, value: unknown): string {
	if (key === 'durationMs' && typeof value === 'number') return formatConsoleDuration(value);
	return formatConsoleValue(value);
}

function formatConsoleDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	return `${Number.isInteger(seconds) ? seconds : Number(seconds.toFixed(2))}s`;
}

function formatConsoleValue(value: unknown): string {
	if (typeof value === 'string') return /\s/.test(value) ? JSON.stringify(value) : value;
	if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
	return JSON.stringify(value);
}

function formatConsoleError(error: Error, enabled: boolean): string {
	const stack = error.stack ?? `${error.name}: ${error.message}`;
	return stack
		.split('\n')
		.map(line => {
			// Header (`Name: message`) in red; `at` frames in the default foreground, same as field values.
			const isFrame = /^\s*at\s/.test(line);
			return isFrame ? `    ${line}` : paint(`    ${line}`, COLOR.error, enabled);
		})
		.join('\n');
}

function jsonErrorReplacer(_key: string, value: unknown): unknown {
	return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

function getConsoleWriter(level: WritableLogLevel): (...args: unknown[]) => void {
	switch (level) {
		case 'trace':
		case 'debug':
			return console.debug;
		case 'warn':
			return console.warn;
		case 'error':
		case 'fatal':
			return console.error;
		default:
			return console.info;
	}
}
