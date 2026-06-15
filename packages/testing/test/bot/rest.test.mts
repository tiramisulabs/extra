import { describe, expect, test } from 'vitest';
import { MockApiHandler } from '../../src/bot/rest';
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
			rest.calls({ method: 'POST', route: /\/channels\/123\/messages$/, body: { content: 'hello' } }),
		).toHaveLength(1);
		expect(
			rest.calls(Routes.createMessage, {
				params: { channelId: '123' },
				body: { content: 'hello' },
				query: { wait: true },
				response: { content: 'hello' },
			}),
		).toHaveLength(1);
		expect(
			rest.calls({
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
			rest.calls({ method: 'GET', route: '/explode', error: (error: unknown) => error instanceof Error }),
		).toHaveLength(1);
		expect(rest.calls({ method: 'GET', route: '/explode', error: 'stub failed' })).toHaveLength(1);
	});
});
