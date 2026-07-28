import { describe, expect, test } from 'vitest';
import {
	createMockBot,
	defineRoute,
	matchRoute,
	type RecordedAction,
	type RestCall,
	type RestCalls,
	Routes,
} from '../../src';

const verdict = defineRoute<{ userId: string }, { ok: boolean }>()({
	method: 'POST',
	route: '/organizations/:orgId/verdict',
});

describe('matchRoute', () => {
	test('extracts params from a route the package does not own, with no bot in sight', () => {
		expect(matchRoute(verdict, { method: 'POST', route: '/organizations/42/verdict' })).toEqual({ orgId: '42' });
	});

	test('a different method does not match', () => {
		expect(matchRoute(verdict, { method: 'GET', route: '/organizations/42/verdict' })).toBeUndefined();
	});

	test('a different path does not match', () => {
		expect(matchRoute(verdict, { method: 'POST', route: '/organizations/42/invite' })).toBeUndefined();
	});

	test('a paramless route matches with an empty param bag', () => {
		const ping = defineRoute<never, undefined>()({ method: 'GET', route: '/health' });

		expect(matchRoute(ping, { method: 'GET', route: '/health' })).toEqual({});
	});

	test('templates are path-only: an origin in the route matches nothing', () => {
		// Pinned deliberately. RouteParamNames reads ':' as a param marker, so "https://…" yields an empty param
		// name and a ":8080" port yields one called "8080", while compileRoute collapses the "//" and finds
		// neither. The three disagree, so the origin has to stay outside the template.
		const withOrigin = defineRoute<never, undefined>()({
			method: 'GET',
			route: 'https://api.example.com/health',
		});

		expect(matchRoute(withOrigin, { method: 'GET', route: 'https://api.example.com/health' })).toBeUndefined();
		expect(matchRoute(withOrigin, { method: 'GET', route: '/health' })).toBeUndefined();
	});

	test('the bot still agrees with the free function after delegating to it', async () => {
		await using bot = await createMockBot({});
		const call = { method: 'POST' as const, route: '/channels/7/messages' };

		expect(bot.rest.matchRouteParams(Routes.createMessage, call)).toEqual({ channelId: '7' });
		expect(bot.rest.matchRouteParams(Routes.createMessage, call)).toEqual(matchRoute(Routes.createMessage, call));
	});
});

describe('a consumer-side recorder built only from the public surface', () => {
	// This is the shape the package deliberately does NOT ship: owning global fetch is the consumer's call.
	// The test exists to prove the exported vocabulary is sufficient to write it.
	function recorder(origin: string) {
		const recorded: RecordedAction[] = [];
		let seq = 0;
		const fetch = (input: string, init: { method?: string; body?: string } = {}) => {
			const url = new URL(input);
			recorded.push({
				seq: seq++,
				method: (init.method ?? 'GET') as RecordedAction['method'],
				// route and query stay apart, exactly as RecordedAction models them
				route: url.pathname,
				query: Object.fromEntries(url.searchParams),
				...(init.body === undefined ? {} : { body: JSON.parse(init.body) as Record<string, unknown> }),
				settled: true,
				response: undefined,
			});
			return new Response('', { status: 200 });
		};
		const calls = ((matcher?: Parameters<RestCalls>[0]) => {
			const out: RestCall<Record<string, string | undefined>, unknown, unknown>[] = [];
			for (const call of recorded) {
				const params = matcher ? matchRoute(matcher, call) : {};
				if (params === undefined) continue;
				out.push({ ...call, params });
			}
			return out;
		}) as RestCalls;
		return { origin, fetch, calls };
	}

	test('replaces stringly URL matching with typed params and a typed body', () => {
		const http = recorder('https://api.example.com');

		http.fetch(`${http.origin}/organizations/42/verdict`, {
			method: 'POST',
			body: JSON.stringify({ userId: '222' }),
		});
		http.fetch(`${http.origin}/organizations/42/invite?resend=1`, {
			method: 'POST',
			body: JSON.stringify({ email: 'a@b.c' }),
		});

		const [call, ...rest] = http.calls(verdict);
		expect(rest).toEqual([]);
		expect(call?.params.orgId).toBe('42');
		expect(call?.body?.userId).toBe('222');

		// the sibling route is excluded by the matcher, not by a negative string filter
		expect(http.calls()).toHaveLength(2);
		expect(http.calls(verdict)).toHaveLength(1);
	});

	test('the query string is queryable instead of being smuggled into the path', () => {
		const invite = defineRoute<{ email: string }, undefined>()({
			method: 'POST',
			route: '/organizations/:orgId/invite',
		});
		const http = recorder('https://api.example.com');

		http.fetch(`${http.origin}/organizations/9/invite?resend=1`, {
			method: 'POST',
			body: JSON.stringify({ email: 'a@b.c' }),
		});

		const [call] = http.calls(invite);
		expect(call?.params.orgId).toBe('9');
		expect(call?.query).toEqual({ resend: '1' });
	});
});
