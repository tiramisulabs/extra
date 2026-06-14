import {
	App,
	getParts,
	type HttpRequest,
	type HttpResponse,
	type TemplatedApp,
	type us_listen_socket,
} from 'uWebSockets.js';
import { ApiHandler, type HttpMethods, type RawFile } from 'seyfert';
export function createProxy(options: {
	token: string;
	port: number;
	baseUrl?: `/${string}`;
	app?: TemplatedApp;
	rest?: ApiHandler;
}) {
	const rest =
		options.rest ??
		new ApiHandler({
			token: options.token,
		});
	const app = options.app ?? App();
	const authKey = `Bot ${options.token}`;
	const sliceLength = options.baseUrl ? options.baseUrl.length + 1 : 8;

	app.any('/*', async (res, req) => {
		res.onAborted(() => {
			res.aborted = true;
		});
		if (res.aborted) return;

		const auth = req.getHeader('authorization');
		if (auth !== authKey) {
			res.writeStatus('401').end('');
			return;
		}
		let body: undefined | Record<string, unknown>;
		const files: RawFile[] = [];
		const method = <HttpMethods>req.getMethod().toUpperCase();
		const query = new URLSearchParams(req.getQuery());
		const path = <`/${string}`>req.getUrl().slice(sliceLength);
		const reason = req.getHeader('x-audit-log-reason');
		if (method !== 'GET' && method !== 'DELETE') {
			try {
				const contentType = req.getHeader('content-type') ?? '';
				if (contentType.includes('multipart/form-data')) {
					const form = await readBody(res, req, contentType);
					if (form) {
						for (let i = 0; i < form.length; i++) {
							const field = form[i];
							if (field.name === 'payload_json') {
								body = parseJsonObject(Buffer.from(field.data).toString());
							} else {
								files.push({
									filename: field.filename || field.name || `file-${i}`,
									data: field.data,
								});
							}
						}
					}
				} else body = await readJson(res);
			} catch (e) {
				writeJsonResponse(res, '400', { message: getErrorMessage(e) });
				return;
			}
		}
		try {
			const result = await rest.request(method, path, {
				body,
				files,
				query,
				reason,
			});
			if (!res.aborted)
				res.cork(() => {
					res.writeHeader('content-type', 'application/json').end(JSON.stringify(result));
				});
		} catch (e) {
			const message = getErrorMessage(e);
			if (!res.aborted)
				res.cork(() => {
					res
						.writeStatus(message.match(/\[[0-9]{1,3}/g)?.[0].slice(1) ?? '500')
						.writeHeader('content-type', 'application/json')
						.end(JSON.stringify({ message }));
				});
		}
	});

	return new Promise<{ result: us_listen_socket | false; app: TemplatedApp }>(r => {
		app.listen(options.port, result => {
			r({ result, app });
		});
	});
}

export function readBuffer(res: HttpResponse) {
	return new Promise<Buffer>((ok, rej) => {
		const buffers: Buffer[] = [];
		res.onData((ab, isLast) => {
			const chunk = Buffer.from(ab);
			if (isLast) {
				try {
					buffers.push(chunk);
					ok(Buffer.concat(buffers));
				} catch (e) {
					res.close();
					rej(e);
					return;
				}
			} else {
				buffers.push(chunk);
			}
		});

		res.onAborted(rej);
	});
}

export async function readJson<T extends Record<string, any>>(res: HttpResponse): Promise<T> {
	const buffer = await readBuffer(res);
	return parseJsonObject(buffer.toString()) as T;
}

export async function readBody(res: HttpResponse, req: HttpRequest, header?: string) {
	const contentType = header ?? req.getHeader('content-type');
	const buffer = await readBuffer(res);
	return getParts(buffer, contentType);
}

function parseJsonObject(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new TypeError('Expected a JSON object body');
	return parsed as Record<string, unknown>;
}

function getErrorMessage(error: unknown): string {
	return typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error);
}

function writeJsonResponse(res: HttpResponse, status: string, body: Record<string, unknown>) {
	if (res.aborted) return;
	res.cork(() => {
		res.writeStatus(status).writeHeader('content-type', 'application/json').end(JSON.stringify(body));
	});
}
