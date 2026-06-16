import { SeyfertError } from 'seyfert/lib/common';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { DiscordErrors, MockApiHandler } from '../../src/bot/rest';
import { Routes } from '../../src/bot/routes';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('MockApiHandler', () => {
	test('records requests and answers POST with a message-shaped echo', async () => {
		const rest = new MockApiHandler();
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
		expect(
			rest.findCalls({ method: 'POST', route: /\/channels\/123\/messages$/, body: { content: 'hello' } }),
		).toHaveLength(1);
		expect(
			rest.findCalls(Routes.createMessage, {
				params: { channelId: '123' },
				body: { content: 'hello' },
				query: { wait: true },
				response: { content: 'hello' },
			}),
		).toHaveLength(1);
		expect(
			rest.findCalls({
				method: 'POST',
				route: '/channels/:channelId/messages',
				params: { channelId: '123' },
				body: { content: 'hello' },
			}),
		).toHaveLength(1);
	});

	test('interceptors take precedence and expose route params', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/guilds/:guildId', (_action, params) => ({ id: params.guildId, name: 'Stubbed' }));
		const response = await rest.request<{ name: string }>('GET', '/guilds/999');
		expect(response.name).toBe('Stubbed');
	});

	test('message GET fallbacks are message-shaped', async () => {
		const rest = new MockApiHandler({ onUnhandledRest: 'silent' });
		const response = await rest.request<{ id: string }>('GET', '/webhooks/app/token/messages/@original');
		expect(response.id).toBeTypeOf('string');
	});

	test('waitForAction resolves on matching action and rejects on timeout', async () => {
		const rest = new MockApiHandler();
		const pending = rest.waitForAction(Routes.followup, 1000);
		await rest.request('POST', '/webhooks/app/token');
		await expect(pending).resolves.toMatchObject({ method: 'POST' });

		const byResponse = rest.waitForAction({
			method: 'POST',
			route: '/channels/:channelId/messages',
			response: { content: 'done' },
		});
		await rest.request('POST', '/channels/1/messages', { body: { content: 'done' } });
		await expect(byResponse).resolves.toMatchObject({ response: { content: 'done' }, params: { channelId: '1' } });

		await expect(rest.waitForAction(action => action.route === '/never', 20)).rejects.toThrow(/timed out/);
	});

	test('records responder errors before rethrowing them', async () => {
		const rest = new MockApiHandler();
		rest.intercept('GET', '/explode', () => {
			throw new Error('stub failed');
		});

		const byError = rest.waitForAction({ method: 'GET', route: '/explode', error: 'stub failed' });
		await expect(rest.request('GET', '/explode')).rejects.toThrow('stub failed');
		await expect(byError).resolves.toMatchObject({ error: expect.any(Error) });
		expect(rest.actions[0]?.error).toBeInstanceOf(Error);
		expect(
			rest.findCalls({ method: 'GET', route: '/explode', error: (error: unknown) => error instanceof Error }),
		).toHaveLength(1);
		expect(rest.findCalls({ method: 'GET', route: '/explode', error: 'stub failed' })).toHaveLength(1);
	});

	test('reset drops user interceptors but keeps world defaults answering', async () => {
		await using bot = await createMockBot();
		bot.rest.intercept(Routes.fetchGuild, () => ({ id: 'stub', name: 'User Stub' }));
		const stubbed = await bot.rest.request<{ name: string }>('GET', '/guilds/42');
		expect(stubbed.name).toBe('User Stub');

		bot.reset();

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
		expect(rest.findCalls(Routes.ban)).toHaveLength(1);
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
