import { createPlugin } from 'seyfert';
import { SeyfertError } from 'seyfert/lib/common';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiError, DiscordErrors, isDiscordError, MockApiHandler, redactRouteTokens } from '../../src/bot/rest';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';
import { discordErrorDetail, expectDiscordError } from './_setup';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('MockApiHandler', () => {
	test.each([
		['/webhooks/application/SUPER-SECRET-TOKEN/messages/@original', '/webhooks/application/:token/messages/@original'],
		['/interactions/interaction/SUPER-SECRET-TOKEN/callback', '/interactions/interaction/:token/callback'],
		['/webhooks/standalone/SUPER-SECRET-TOKEN', '/webhooks/standalone/:token'],
	])('redacts credential-bearing route segments in %s', (route, expected) => {
		const diagnostic = redactRouteTokens(route);
		expect(diagnostic).toBe(expected);
		expect(diagnostic).not.toContain('SUPER-SECRET-TOKEN');
	});

	test('records requests and answers POST with a message-shaped echo', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const response = await rest.request<{ id: string; content: string }>('POST', '/channels/123/messages', {
			body: { content: 'hello' },
			query: { wait: true },
			reason: 'cleanup',
		});
		expect(response.content).toBe('hello');
		expect(response.id).toBeDefined();
		expect(rest.actions).toHaveLength(1);
		expect(rest.actions[0]).toMatchObject({
			method: 'POST',
			route: '/channels/123/messages',
			body: { content: 'hello' },
			query: { wait: true },
			reason: 'cleanup',
		});
	});

	test('world-backed missing fetches fail, while explicit silent fallbacks are stamped synthetic', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'syn-guild' });
		const channel = world.registerChannel(guild.id, { id: 'syn-channel' });
		const bot = await createMockBot({ world });

		const real = await bot.rest.request<{ id: string }>('GET', `/channels/${channel.id}`);
		expect(real.id).toBe(channel.id);
		expect(bot.rest.actions.at(-1)?.synthetic).toBeFalsy();

		await expectDiscordError(bot.rest.request('GET', '/channels/does-not-exist'), DiscordErrors.UnknownChannel);
		await bot.close();

		const synthetic = await createMockBot({ onUnhandledRest: 'silent' });
		const ghost = await synthetic.rest.request<{ id: string }>('GET', '/channels/does-not-exist');
		expect(ghost.id).toBe('does-not-exist');
		expect(synthetic.rest.actions.at(-1)?.synthetic).toBe(true);
		await synthetic.close();
	});

	test('interceptors take precedence and expose route params', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/guilds/:guildId', (_action, params) => ({ id: params.guildId, name: 'Stubbed' }));
		const response = await rest.request<{ name: string }>('GET', '/guilds/999');
		expect(response.name).toBe('Stubbed');
	});

	test('routeUrl and call support typed route params', async () => {
		const rest = new MockApiHandler();
		rest.intercept(Routes.fetchGuild, (_action, params) => ({ id: params.guildId, name: 'Typed' }));

		expect(rest.routeUrl(Routes.fetchGuild, { guildId: '999' })).toBe('/guilds/999');
		const response = (await rest.call(Routes.fetchGuild, { guildId: '999' })) as { id: string; name: string };
		expect(response).toEqual({ id: '999', name: 'Typed' });
		const recorded = rest.actions[0];
		expect(recorded).toBeDefined();
		if (!recorded) throw new Error('Expected the typed REST call to be recorded.');
		expect(rest.matchRouteParams(Routes.fetchGuild, recorded)?.guildId).toBe('999');
	});

	test('notifies plugin REST observers for mock success, failure, and ratelimits', async () => {
		const seen: {
			phase: string;
			client?: unknown;
			method?: string;
			url?: string;
			query?: unknown;
			status?: number;
			statusCode?: number;
		}[] = [];
		const plugin = createPlugin({
			name: 'slipher-rest-observer',
			register(api) {
				api.rest.observe({
					onRequest(payload) {
						seen.push({
							phase: 'request',
							client: payload.client,
							method: payload.method,
							url: payload.url,
							query: payload.request.query,
						});
					},
					onSuccess(payload) {
						seen.push({ phase: 'success', status: payload.response.status });
					},
					onRatelimit(payload) {
						seen.push({ phase: 'ratelimit', status: payload.response.status });
					},
					onFail(payload) {
						seen.push({ phase: 'fail', statusCode: payload.statusCode });
					},
				});
			},
		});
		const bot = await createMockBot({ plugins: [plugin], onUnhandledRest: 'silent' });

		await bot.rest.request('GET', '/guilds/observer', { query: { with_counts: true } });
		bot.rest.fail(Routes.fetchGuild, DiscordErrors.MissingAccess, { times: 1 });
		await expect(bot.rest.request('GET', '/guilds/blocked')).rejects.toBeInstanceOf(SeyfertError);
		bot.rest.fail(Routes.createMessage, DiscordErrors.RateLimited, { times: 1 });
		await expect(bot.rest.request('POST', '/channels/observer/messages')).rejects.toBeInstanceOf(SeyfertError);

		expect(seen[0]?.client).toBe(bot.client);
		expect(
			seen.map(({ phase, method, url, query, status, statusCode }) => ({
				phase,
				method,
				url,
				query,
				status,
				statusCode,
			})),
		).toEqual([
			{
				phase: 'request',
				method: 'GET',
				url: '/guilds/observer?with_counts=true',
				query: { with_counts: true },
				status: undefined,
				statusCode: undefined,
			},
			{ phase: 'success', method: undefined, url: undefined, query: undefined, status: 200, statusCode: undefined },
			{
				phase: 'request',
				method: 'GET',
				url: '/guilds/blocked',
				query: undefined,
				status: undefined,
				statusCode: undefined,
			},
			{ phase: 'fail', method: undefined, url: undefined, query: undefined, status: undefined, statusCode: 403 },
			{
				phase: 'request',
				method: 'POST',
				url: '/channels/observer/messages',
				query: undefined,
				status: undefined,
				statusCode: undefined,
			},
			{ phase: 'ratelimit', method: undefined, url: undefined, query: undefined, status: 429, statusCode: undefined },
			{ phase: 'fail', method: undefined, url: undefined, query: undefined, status: undefined, statusCode: 429 },
		]);
		await bot.close();
	});

	test('a 429 raised by apiError still reaches onRatelimit, with the parsed body', async () => {
		// The rate-limit notification is decided off the error's status. That lookup used to read MockApiError's
		// own field; it now reads what parseError filed, and an interceptor's apiError has to keep tripping it.
		const seen: { status: number; body: unknown }[] = [];
		const plugin = createPlugin({
			name: 'slipher-ratelimit-observer',
			register(api) {
				api.rest.observe({
					async onRatelimit(payload) {
						seen.push({ status: payload.response.status, body: await payload.response.json() });
					},
				});
			},
		});
		const bot = await createMockBot({ plugins: [plugin], onUnhandledRest: 'silent' });
		bot.rest.intercept(Routes.createMessage, () => apiError({ ...DiscordErrors.RateLimited, retryAfter: 7 }));

		await expect(bot.rest.request('POST', '/channels/limited/messages')).rejects.toBeInstanceOf(SeyfertError);

		expect(seen).toEqual([{ status: 429, body: { code: 0, message: 'You are being rate limited.', retry_after: 7 } }]);
		await bot.close();
	});

	test('strict mode rejects unmodeled non-GET fallbacks', async () => {
		const rest = new MockApiHandler();
		await expect(rest.request('POST', '/not-modeled-route', { body: { content: 'x' } })).rejects.toThrow(
			/no interceptor or world entity/,
		);
	});

	test('message GET fallbacks are message-shaped', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const response = await rest.request<{ id: string }>('GET', '/webhooks/app/token/messages/@original');
		expect(response.id).toBeTypeOf('string');
	});

	test('internal action wait resolves on a matching action and rejects on timeout', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const pending = rest.waitUntilAction(Routes.followup, 1000);
		await rest.request('POST', '/webhooks/app/token');
		await expect(pending).resolves.toMatchObject({ method: 'POST' });

		await expect(rest.waitUntilAction(action => action.route === '/never', 20)).rejects.toThrow(/timed out/i);
	});

	test('internal action wait waits for an existing pending action to settle', async () => {
		const rest = new MockApiHandler();
		let release!: (value: unknown) => void;
		rest.intercept(
			'GET',
			'/slow',
			() =>
				new Promise(resolve => {
					release = resolve;
				}),
		);

		const request = rest.request('GET', '/slow');
		const action = rest.waitUntilAction({ method: 'GET', route: '/slow' });
		await Promise.resolve();
		expect(rest.actions[0]?.response).toBeUndefined();

		release({ ok: true });
		await expect(action).resolves.toMatchObject({ response: { ok: true } });
		await expect(request).resolves.toEqual({ ok: true });
	});

	test('internal action wait treats a settled undefined response as complete', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/void', () => undefined);

		const action = rest.waitUntilAction({ method: 'GET', route: '/void' });
		await expect(rest.request('GET', '/void')).resolves.toBeUndefined();
		await expect(action).resolves.toMatchObject({ settled: true, response: undefined });
	});

	test('records responder errors before rethrowing them', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/explode', () => {
			throw new Error('stub failed');
		});

		const byError = rest.waitUntilAction({ method: 'GET', route: '/explode' });
		await expect(rest.request('GET', '/explode')).rejects.toThrow('stub failed');
		await expect(byError).resolves.toMatchObject({ error: expect.any(Error) });
		expect(rest.actions[0]?.error).toBeInstanceOf(Error);
	});

	test('reset drops user interceptors but keeps world defaults answering', async () => {
		await using bot = await createMockBot();
		bot.rest.intercept(Routes.fetchGuild, () => ({ id: 'stub', name: 'User Stub' }));
		const stubbed = await bot.rest.request<{ name: string }>('GET', '/guilds/42');
		expect(stubbed.name).toBe('User Stub');

		await bot.reset();

		const afterReset = await bot.rest.request<{ id: string; name: string }>('GET', '/guilds/42');
		expect(afterReset.name).not.toBe('User Stub');
		expect(afterReset.id).toBe('42');
	});

	test('intercept returns a disposer that removes only that interceptor', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const off = rest.intercept('GET', '/guilds/:guildId', (_action, params) => ({
			id: params.guildId,
			name: 'Stubbed',
		}));
		const stubbed = await rest.request<{ name: string }>('GET', '/guilds/999');
		expect(stubbed.name).toBe('Stubbed');

		off();

		const fallback = await rest.request<{ name?: string }>('GET', '/guilds/999');
		expect(fallback.name).toBeUndefined();
	});
});

describe('MockApiHandler.fail', () => {
	test('rejects with a Discord-faithful SeyfertError from a catalog entry', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		rest.fail(Routes.ban, DiscordErrors.MissingPermissions);

		const error = (await rest.request('PUT', '/guilds/1/bans/2').then(
			() => undefined,
			(e: unknown) => e,
		)) as SeyfertError;

		expect(error).toBeInstanceOf(SeyfertError);
		expect(error.name).toBe('SeyfertError');
		expect(error.code).toBe('API_Forbidden_50013');
		const metadata = error.metadata as { status: number; statusText: string; response: { code: number } };
		expect(metadata.status).toBe(403);
		expect(metadata.statusText).toBe('Forbidden');
		expect(metadata.response.code).toBe(50013);
		expect(rest.actions.filter(action => rest.matches(Routes.ban, action))).toHaveLength(1);
	});

	test('synthesizes statusText for a raw shape and passes retryAfter through', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		rest.fail(Routes.createMessage, { status: 429, retryAfter: 5 });

		const error = (await rest.request('POST', '/channels/1/messages').then(
			() => undefined,
			(e: unknown) => e,
		)) as SeyfertError;

		expect(error.code).toBe('API_Too Many Requests_0');
		const metadata = error.metadata as { statusText: string; response: { retry_after?: number } };
		expect(metadata.statusText).toBe('Too Many Requests');
		expect(metadata.response.retry_after).toBe(5);
	});

	test('{ times } fails the first N calls then falls through', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		rest.fail(Routes.fetchGuild, DiscordErrors.UnknownMember, { times: 2 });

		await expect(rest.request('GET', '/guilds/9')).rejects.toBeInstanceOf(SeyfertError);
		await expect(rest.request('GET', '/guilds/9')).rejects.toBeInstanceOf(SeyfertError);
		await expect(rest.request('GET', '/guilds/9')).resolves.toBeDefined();
	});

	test('returns a disposer that restores normal handling', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const off = rest.fail(Routes.fetchGuild, DiscordErrors.MissingAccess);
		await expect(rest.request('GET', '/guilds/9')).rejects.toBeInstanceOf(SeyfertError);
		off();
		await expect(rest.request('GET', '/guilds/9')).resolves.toBeDefined();
	});
});

describe('responder return values', () => {
	test('a responder that answers with a non-payload is named at the route, not inside seyfert', async () => {
		const bot = await createMockBot({});
		bot.rest.intercept(Routes.createMessage, () => 'not an object' as never);

		// unguarded this died as `TypeError: Cannot read properties of undefined (reading 'startsWith')`
		// several frames away in seyfert's cache, naming neither the route nor the responder
		await expect(bot.client.messages.write('chan-1', { content: 'x' })).rejects.toThrow(
			/intercept\(POST \/channels\/chan-1\/messages\).*returned the string "not an object"/s,
		);
		await expect(bot.client.messages.write('chan-1', { content: 'x' })).rejects.toThrow(/rest\.fail/);
		await bot.close();
	});

	test('an empty body stays legal — a 204 has no payload', async () => {
		const bot = await createMockBot({});
		bot.rest.intercept(Routes.deleteMessage, () => undefined);

		await expect(bot.client.messages.delete('m-1', 'chan-1')).resolves.toBeUndefined();
		await bot.close();
	});
});

describe('one error model, one predicate', () => {
	test('a seeded world and rest.fail() reject with the same error a real 404 would', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'narrow-guild' });
		const channel = world.registerChannel(guild.id);
		const bot = await createMockBot({ world });

		// a world guard, reached because the message was never seeded
		const guardError = await bot.client.messages.fetch('ghost', channel.id).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		// an injected failure on a route the world would have answered
		bot.rest.fail(Routes.fetchChannel, DiscordErrors.UnknownChannel);
		const failError = await bot.client.channels.fetch('ghost').then(
			() => undefined,
			(reason: unknown) => reason,
		);

		// The point of the whole seam: a command cannot tell a seeded failure from an injected one, because
		// both are what seyfert's own parseError builds from a Discord response.
		expect(guardError).toBeInstanceOf(SeyfertError);
		expect(failError).toBeInstanceOf(SeyfertError);
		expect(guardError?.constructor).toBe(failError?.constructor);
		expect((guardError as SeyfertError).metadata).toMatchObject({
			method: 'GET',
			route: `/channels/${channel.id}/messages/ghost`,
			status: 404,
			statusText: 'Not Found',
			response: { code: DiscordErrors.UnknownMessage.code, message: 'Unknown Message' },
		});

		// one predicate answers for both, on the fields Discord sends
		expect(isDiscordError(guardError, { status: 404, code: DiscordErrors.UnknownMessage.code })).toBe(true);
		expect(isDiscordError(failError, { status: 404, code: DiscordErrors.UnknownChannel.code })).toBe(true);
		expect(isDiscordError(guardError, { code: DiscordErrors.UnknownChannel.code })).toBe(false);
		expect(isDiscordError(guardError, { status: 403, code: DiscordErrors.UnknownMessage.code })).toBe(false);
		expect(isDiscordError(new Error('not a discord error'))).toBe(false);
		await bot.close();
	});

	test('the catalog carries the copy, and per-call detail survives on the parsed response', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'copy-guild' });
		const channel = world.registerChannel(guild.id, { id: 'copy-chan' });
		const bot = await createMockBot({ world });

		// seyfert renames the error after the status text and the code, so the copy lives on metadata.response
		const catalogError = await bot.client.channels.fetch('ghost').then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect((catalogError as Error).message).toBe('Api Not found 10003');
		expect(discordErrorDetail(catalogError)).toBe('Unknown Channel');

		// per-call detail still overrides the catalog copy, which is why apiError's second argument exists
		await expectDiscordError(
			bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { embeds: new Array(11).fill({}) } }),
			DiscordErrors.InvalidFormBody,
			/^Invalid Form Body: a message can have at most 10 embeds$/,
		);
		await bot.close();
	});
});

describe('conditional failure injection', () => {
	test('when() decides per call, and a declined call still reaches the real handler', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'when-guild' });
		const keep = world.registerChannel(guild.id, { id: 'keep-chan' });
		const drop = world.registerChannel(guild.id, { id: 'drop-chan' });
		const bot = await createMockBot({ world });

		bot.rest.fail(Routes.createMessage, DiscordErrors.MissingPermissions, {
			when: (_action, params) => params.channelId === 'drop-chan',
		});

		const denied = await bot.client.messages.write(drop.id, { content: 'nope' }).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(isDiscordError(denied, { code: DiscordErrors.MissingPermissions.code })).toBe(true);
		// the declined call is not swallowed: the world default answered it, so the message really landed
		await bot.client.messages.write(keep.id, { content: 'yes' });
		expect(bot.world.query.channel({ id: keep.id })?.lastMessage?.content).toBe('yes');
		await bot.close();
	});

	test('when() and times() compose: fail the matching calls, but only the first of them', async () => {
		const bot = await createMockBot({});
		const attempts: string[] = [];
		bot.rest.fail(Routes.createMessage, DiscordErrors.RateLimited, {
			times: 1,
			when: action => (action.body as { content?: string })?.content === 'retry-me',
		});

		for (const content of ['other', 'retry-me', 'retry-me']) {
			await bot.client.messages
				.write('chan-1', { content })
				.then(() => attempts.push(`${content}:ok`))
				.catch(() => attempts.push(`${content}:failed`));
		}

		expect(attempts).toEqual(['other:ok', 'retry-me:failed', 'retry-me:ok']);
		await bot.close();
	});

	test('retryAfter reaches the handler, so an app-level backoff is assertable', async () => {
		const bot = await createMockBot({});
		bot.rest.fail(Routes.createMessage, { ...DiscordErrors.RateLimited, retryAfter: 3 });

		const seen = await bot.client.messages.write('chan-1', { content: 'x' }).then(
			() => undefined,
			(error: { metadata?: { response?: { retry_after?: number } } }) => error?.metadata?.response?.retry_after,
		);

		// the mock does not run seyfert's own retry pipeline; what it guarantees is that the value the app
		// backs off on is the value the test set
		expect(seen).toBe(3);
		await bot.close();
	});
});
