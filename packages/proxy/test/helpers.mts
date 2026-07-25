import http from 'node:http';
import { ApiHandler } from 'seyfert';
import { createProxy, createServiceCredential, ProxyApiHandler, type ProxyServerOptions } from '../src';

export async function startProxy(
	fetcher: typeof fetch,
	options: Partial<Omit<ProxyServerOptions, 'rest' | 'credentials' | 'port'>> = {},
) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetcher;
	const service = createServiceCredential('test-service');
	const rest = new ApiHandler({ token: 'discord-token', workerProxy: false });
	const { authenticate, ...serverOptions } = options;
	const proxy = await createProxy({
		rest,
		createRestForToken: token => new ApiHandler({ token, workerProxy: false }),
		...(authenticate ? { authenticate } : { credentials: [service.hash] }),
		port: 0,
		...serverOptions,
	});
	const handler = new ProxyApiHandler({ url: proxy.url, credential: service.credential });
	return {
		proxy,
		handler,
		rest,
		service,
		async close(drainTimeout = 1_000) {
			await proxy.close({ drainTimeout });
			globalThis.fetch = originalFetch;
		},
	};
}

export function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(body === undefined ? undefined : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

export function request(
	url: string,
	options: {
		path: string;
		credential?: string;
		method?: string;
		body?: string;
		contentType?: string;
		requestId?: string;
	},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const target = new URL(options.path, url);
		const req = http.request(
			target,
			{
				method: options.method ?? 'GET',
				headers: {
					...(options.credential ? { authorization: `Bearer ${options.credential}` } : {}),
					...(options.body === undefined ? {} : { 'content-length': Buffer.byteLength(options.body) }),
					...(options.contentType ? { 'content-type': options.contentType } : {}),
					...(options.requestId ? { 'x-proxy-request-id': options.requestId } : {}),
				},
			},
			res => {
				const chunks: Buffer[] = [];
				res.on('data', chunk => chunks.push(Buffer.from(chunk)));
				res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
			},
		);
		req.once('error', reject);
		req.end(options.body);
	});
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}
