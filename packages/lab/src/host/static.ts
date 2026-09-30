import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { HttpError, isWithin } from './http';

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
};

/** Resolves a URL path to a file in `uiRoot`; extensionless misses fall back to `index.html` for SPA routes. */
async function resolveUiFile(uiRoot: string, pathname: string): Promise<string> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		throw new HttpError(400, 'Invalid URL path');
	}
	const requested = resolve(uiRoot, `.${decoded}`);
	if (!isWithin(uiRoot, requested)) throw new HttpError(403, 'Path outside UI directory');
	const index = resolve(uiRoot, 'index.html');
	let file: string;
	try {
		file = (await stat(requested)).isFile() ? requested : index;
	} catch {
		if (extname(decoded)) throw new HttpError(404, 'File not found');
		file = index;
	}
	let actual: string;
	let isFile: boolean;
	try {
		actual = await realpath(file);
		isFile = (await stat(actual)).isFile();
	} catch {
		throw new HttpError(404, 'File not found');
	}
	// A symlink inside uiRoot may still point elsewhere.
	if (!isWithin(uiRoot, actual) || !isFile) throw new HttpError(403, 'Path outside UI directory');
	return actual;
}

/** `uiRoot` must already be a real path. Without a UI, every page explains how to install one. */
export async function serveUi(
	uiRoot: string | undefined,
	pathname: string,
	res: ServerResponse,
	head: boolean,
): Promise<void> {
	if (!uiRoot) {
		res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(head ? undefined : 'Lab UI is not installed. Install @slipher/lab-ui or pass --ui <dir>.');
		return;
	}
	const file = await resolveUiFile(uiRoot, pathname);
	res.writeHead(200, {
		'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
		'x-content-type-options': 'nosniff',
	});
	if (head) res.end();
	else createReadStream(file).pipe(res);
}
