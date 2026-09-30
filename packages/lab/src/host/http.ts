import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, relative, sep } from 'node:path';
import { errorText } from '../shared';

const MAX_BODY_BYTES = 1024 * 1024;

/** An error whose status, message and optional detail fields are sent to the client as JSON. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly detail?: Record<string, string>,
	) {
		super(message);
	}
}

export function isErrnoCode(error: unknown, code: string): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

/** Returns `value` once `check` accepts it; a rejection becomes a 400 carrying the validator's message. */
export function validated<T>(value: unknown, check: (value: unknown) => asserts value is T): T {
	try {
		check(value);
		return value;
	} catch (error) {
		throw new HttpError(400, errorText(error));
	}
}

/** Whether `path` is `root` or a descendant of it; both must already be resolved. */
export function isWithin(root: string, path: string): boolean {
	const rest = relative(root, path);
	return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/** Reads a JSON body of at most 1 MiB. An empty body reads as `{}` when `allowEmpty` is set. */
export async function readJsonBody(req: IncomingMessage, allowEmpty = false): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body exceeds 1 MiB');
		chunks.push(bytes);
	}
	if (size === 0 && allowEmpty) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} catch {
		throw new HttpError(400, 'Invalid JSON body');
	}
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(value));
}
