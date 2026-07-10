import {
	App,
	getParts,
	type HttpRequest,
	type HttpResponse,
	type TemplatedApp,
	type us_listen_socket,
} from 'uWebSockets.js';
import { ApiHandler, type HttpMethods, type RawFile } from 'seyfert';
import { isMultipartContentType, parseJsonObject, parseMultipartBody } from './parsing';

function writeBadRequest(res: HttpResponse, message: string) {
	if (!res.aborted)
		res.cork(() => {
			res.writeStatus('400').writeHeader('content-type', 'application/json').end(JSON.stringify({ message }));
		});
}

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
		if (res.aborted) {
			res.writeStatus('401');
			return;
		}

		const auth = req.getHeader('authorization');
		if (auth !== authKey) {
			res.writeStatus('401').end('');
			return;
		}
		let body: undefined | Record<string, unknown>;
		let files: RawFile[] = [];
		const method = <HttpMethods>req.getMethod().toUpperCase();
		const query = new URLSearchParams(req.getQuery());
		const path = <`/${string}`>req.getUrl().slice(sliceLength);
		const reason = req.getHeader('x-audit-log-reason');
		if (method !== 'GET' && method !== 'DELETE') {
			const contentType = req.getHeader('content-type');
			if (isMultipartContentType(contentType)) {
				const form = await readBody(res, req, contentType);
				if (form) {
					const parsed = parseMultipartBody(form);
					if (!parsed.ok) return writeBadRequest(res, parsed.message);
					body = parsed.body;
					files = parsed.files;
				}
			} else {
				const parsed = parseJsonObject(await readBuffer(res));
				if (!parsed.ok) return writeBadRequest(res, parsed.message);
				body = parsed.value;
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
			const message = typeof e === 'object' && e && 'message' in e ? (e.message as string) : String(e);
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
	return JSON.parse(buffer.toString());
}

export async function readBody(res: HttpResponse, req: HttpRequest, contentType = req.getHeader('content-type')) {
	const buffer = await readBuffer(res);
	return getParts(buffer, contentType);
}
