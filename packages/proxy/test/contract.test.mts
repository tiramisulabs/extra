import http from 'node:http';
import { ApiHandler, SeyfertError } from 'seyfert';
import { afterEach, assert, describe, test } from 'vitest';
import { ProxyApiHandler } from '../src';

let server: http.Server | undefined;

afterEach(async () => {
	await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
	server = undefined;
});

describe('Seyfert ApiHandler contract', () => {
	test('is injectable and reconstructs the installed SeyfertError type with a local stack', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					kind: 'discord_error',
					status: 403,
					body: { code: 50013, message: 'Missing Permissions' },
					error: {
						code: 'API_FORBIDDEN_50013',
						metadata: { status: 403, response: { code: 50013, message: 'Missing Permissions' } },
					},
				}),
			);
		});
		await new Promise<void>(resolve => server!.listen(0, resolve));
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const handler = new ProxyApiHandler({ url: `http://127.0.0.1:${address.port}`, credential: 'contract' });

		assert.instanceOf(handler, ApiHandler);
		const error = await handler.request('GET', '/channels/1').catch(value => value);
		assert.instanceOf(error, SeyfertError);
		assert.equal(error.code, 'API_FORBIDDEN_50013');
		assert.equal(error.metadata.status, 403);
		assert.match(error.stack, /contract\.test\.mts/);
	});
});
