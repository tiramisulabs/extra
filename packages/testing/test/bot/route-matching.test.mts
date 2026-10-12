import { describe, expect, test } from 'vitest';
import { defineRoute, matchRoute } from '../../src';

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
});
