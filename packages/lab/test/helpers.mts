import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { LabHost } from '../src/host';

const dataDirs: string[] = [];

/** A fresh host data directory, removed by the next `closeHosts`. */
export async function tempDataDir(): Promise<string> {
	const dataDir = await mkdtemp(resolve(tmpdir(), 'slipher-lab-'));
	dataDirs.push(dataDir);
	return dataDir;
}

/** Closes and forgets `hosts`, then removes every data directory created since the last call. */
export async function closeHosts(hosts: LabHost[]): Promise<void> {
	try {
		for (const host of hosts.splice(0)) await host.close();
	} finally {
		for (const dataDir of dataDirs.splice(0)) await rm(dataDir, { recursive: true, force: true });
	}
}

export function hostedRequest(
	host: LabHost,
	origin: string,
	path: string,
	options: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
	const method = options.method ?? 'GET';
	const target = new URL(host.url);
	return new Promise<Response>((done, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method,
				headers: {
					Host: new URL(origin).host,
					...(method !== 'GET' && method !== 'HEAD' ? { Origin: origin, 'content-type': 'application/json' } : {}),
					...(options.cookie ? { Cookie: options.cookie } : {}),
					...options.headers,
				},
			},
			response => {
				const headers = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(name, item);
					else if (value !== undefined) headers.append(name, value);
				}
				const status = response.statusCode ?? 500;
				const noBody = method === 'HEAD' || status === 204 || status === 304;
				if (noBody) response.resume();
				done(
					new Response(noBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers }),
				);
			},
		);
		req.on('error', reject);
		req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
	});
}
