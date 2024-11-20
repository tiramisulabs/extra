import { ApiHandler, type HttpMethods, type RawFile } from 'seyfert';
import {
	App,
	type HttpRequest,
	type HttpResponse,
	type TemplatedApp,
	getParts,
	type us_listen_socket,
} from 'uWebSockets.js';
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
		const files: RawFile[] = [];
		const method = <HttpMethods>req.getMethod().toUpperCase();
		const query = new URLSearchParams(req.getQuery());
		const path = <`/${string}`>req.getUrl().slice(sliceLength);
		if (method !== 'GET' && method !== 'DELETE') {
			const contentType = req.getHeader('content-type');
			if (contentType.includes('multipart/form-data')) {
				const form = await readBody(res, req);
				if (form) {
					for (let i = 0; i < form.length; i++) {
						const field = form[i];
						if (field.name === 'payload_json') {
							body = JSON.parse(Buffer.from(field.data).toString());
						} else {
							files.push({
								filename: field.filename!,
								data: field.data,
							});
						}
					}
				}
			} else body = await readJson(res);
		}
		try {
			const reason = req.getHeader('x-audit-log-reason');
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

export async function readBody(res: HttpResponse, req: HttpRequest) {
	const contentType = req.getHeader('content-type');
	const buffer = await readBuffer(res);
	return getParts(buffer, contentType);
}
