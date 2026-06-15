import { ApiHandler } from 'seyfert';
import type { ApiRequestOptions, HttpMethods } from 'seyfert/lib/api/shared';
import { apiMessage } from './payloads';
import { CHANNEL_MESSAGE_POST, WEBHOOK_EXECUTE_POST } from './routes';

export interface RecordedAction {
	seq: number;
	method: HttpMethods;
	route: string;
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
	files?: unknown[];
	/** Audit-log reason, when the command passed one. */
	reason?: string;
	/** The responder's result; undefined while an async responder is pending. */
	response: unknown;
	/** The responder error; set before the original error is rethrown. */
	error?: unknown;
}

export function isOutgoingMessagePost(action: RecordedAction): boolean {
	return action.method === 'POST' && (CHANNEL_MESSAGE_POST.test(action.route) || WEBHOOK_EXECUTE_POST.test(action.route));
}

export class MockApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = 'MockApiError';
	}
}

export function apiError(status: number, code: number, message: string): never {
	throw new MockApiError(status, code, message);
}

export function gate(): { open: Promise<void>; release: () => void } {
	let release!: () => void;
	const open = new Promise<void>(resolve => {
		release = resolve;
	});
	return { open, release };
}

export type PendingAction = Omit<RecordedAction, 'response' | 'seq'>;

export type RouteResponder = (action: PendingAction, params: Record<string, string>) => unknown;

export interface RouteMatcher {
	method: HttpMethods;
	route: string;
}

/** A recorded action enriched with the route params its matcher captured. */
export type MatchedAction = RecordedAction & { params: Record<string, string> };

export type ActionPredicate = (action: RecordedAction) => boolean;
export type ValuePredicate<T> = (value: T, action: RecordedAction) => boolean;

export interface ActionFilter {
	method?: HttpMethods;
	route?: string | RegExp | ValuePredicate<string>;
	params?: Record<string, string>;
	body?: Record<string, unknown> | ValuePredicate<Record<string, unknown> | undefined>;
	query?: Record<string, unknown> | ValuePredicate<Record<string, unknown> | undefined>;
	files?: unknown[] | ValuePredicate<unknown[] | undefined>;
	reason?: string | ValuePredicate<string | undefined>;
	response?: string | number | boolean | null | Record<string, unknown> | unknown[] | ValuePredicate<unknown>;
	error?: Error | string | ValuePredicate<unknown>;
}

export type RouteActionFilter = Omit<ActionFilter, 'method' | 'route'>;
export type ActionMatcher = RouteMatcher | ActionFilter | ActionPredicate;

interface Interceptor {
	method: HttpMethods;
	pattern: RegExp;
	names: string[];
	responder: RouteResponder;
}

type NotifyPhase = 'pending' | 'settled';

interface ActionListener {
	onAction(action: RecordedAction, phase: NotifyPhase): void;
	timer: ReturnType<typeof setTimeout>;
	reject(error: Error): void;
}

interface RequestGate {
	test(action: RecordedAction): boolean;
	hold(): Promise<void>;
	release(): void;
}

function compileRoute(route: string): { pattern: RegExp; names: string[] } {
	const names: string[] = [];
	const source = route
		.split('/')
		.filter(part => part.length > 0)
		.map(part => {
			if (part.startsWith(':')) {
				names.push(part.slice(1));
				return '([^/]+)';
			}
			return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('/');
	return { pattern: new RegExp(`^/${source}$`), names };
}

function definedBody(body: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!body) return {};
	return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
	if (typeof expected === 'function') return false;
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual)) return false;
		return expected.every((value, index) => matchesSubset(actual[index], value));
	}
	if (isRecord(expected)) {
		if (!isRecord(actual)) return false;
		return Object.entries(expected).every(([key, value]) => matchesSubset(actual[key], value));
	}
	return Object.is(actual, expected);
}

function matchesValue<T>(
	actual: T,
	expected: unknown | ValuePredicate<T> | undefined,
	action: RecordedAction,
): boolean {
	if (expected === undefined) return true;
	if (typeof expected === 'function') return (expected as ValuePredicate<T>)(actual, action);
	return matchesSubset(actual, expected);
}

function matchesError(actual: unknown, expected: ActionFilter['error'], action: RecordedAction): boolean {
	if (expected === undefined) return true;
	if (typeof expected === 'function') return expected(actual, action);
	if (typeof expected === 'string')
		return actual instanceof Error ? actual.message === expected : Object.is(actual, expected);
	if (expected instanceof Error) {
		return actual instanceof Error && actual.name === expected.name && actual.message === expected.message;
	}
	return matchesSubset(actual, expected);
}

function hasRouteFilterKeys(value: Record<string, unknown>): boolean {
	return ['params', 'body', 'query', 'files', 'reason', 'response', 'error'].some(key => key in value);
}

function isRouteMatcherOnly(value: ActionMatcher): value is RouteMatcher {
	return (
		typeof value === 'object' &&
		value !== null &&
		'method' in value &&
		'route' in value &&
		typeof value.route === 'string' &&
		!hasRouteFilterKeys(value as Record<string, unknown>)
	);
}

function normalizeRouteActionFilter(paramsOrFilter?: Record<string, string> | RouteActionFilter): RouteActionFilter {
	if (!paramsOrFilter) return {};
	return hasRouteFilterKeys(paramsOrFilter as Record<string, unknown>)
		? (paramsOrFilter as RouteActionFilter)
		: { params: paramsOrFilter as Record<string, string> };
}

export class MockApiHandler extends ApiHandler {
	readonly actions: RecordedAction[] = [];
	private listeners: ActionListener[] = [];
	private interceptors: Interceptor[] = [];
	private defaultInterceptors: Interceptor[] = [];
	private gates: RequestGate[] = [];
	private seq = 0;
	private readonly unhandled: 'warn' | 'error' | 'silent';
	private readonly routeCache = new Map<string, { pattern: RegExp; names: string[] }>();
	private readonly warnedRoutes = new Set<string>();

	constructor(options: { onUnhandledRest?: 'warn' | 'error' | 'silent' } = {}) {
		super({ token: 'slipher-mock-token' });
		this.unhandled = options.onUnhandledRest ?? 'warn';
	}

	private reportUnhandled(pending: PendingAction): void {
		if (this.unhandled === 'silent') return;
		const message =
			`[@slipher/testing] no interceptor or world entity matched GET ${pending.route} - ` +
			`answered with a synthetic fallback. Seed the world, stub it with intercept(), ` +
			`or pass onUnhandledRest: 'silent' to createMockBot.`;
		if (this.unhandled === 'error') throw new Error(message);
		if (this.warnedRoutes.has(pending.route)) return;
		this.warnedRoutes.add(pending.route);
		console.warn(message);
	}

	intercept(matcher: RouteMatcher, responder: RouteResponder): () => void;
	intercept(method: HttpMethods, route: string | RegExp, responder: RouteResponder): () => void;
	intercept(
		methodOrMatcher: HttpMethods | RouteMatcher,
		routeOrResponder: string | RegExp | RouteResponder,
		maybeResponder?: RouteResponder,
	): () => void {
		if (typeof methodOrMatcher === 'object') {
			return this.intercept(methodOrMatcher.method, methodOrMatcher.route, routeOrResponder as RouteResponder);
		}

		const responder = maybeResponder;
		if (!responder || typeof routeOrResponder === 'function') {
			throw new TypeError('MockApiHandler.intercept requires a route and responder');
		}
		const compiled =
			typeof routeOrResponder === 'string' ? compileRoute(routeOrResponder) : { pattern: routeOrResponder, names: [] };
		const interceptor: Interceptor = { method: methodOrMatcher, ...compiled, responder };
		this.interceptors.unshift(interceptor);
		return () => {
			const index = this.interceptors.indexOf(interceptor);
			if (index !== -1) this.interceptors.splice(index, 1);
		};
	}

	/**
	 * Snapshot the current interceptor set as the construction-time baseline. Called once in
	 * createMockBot after registerWorldDefaults so resetInterceptors() can restore world defaults.
	 */
	markDefaultsBaseline(): void {
		this.defaultInterceptors = [...this.interceptors];
	}

	/** Drop user-added interceptors, restoring exactly the construction-time world defaults. */
	resetInterceptors(): void {
		this.interceptors = [...this.defaultInterceptors];
	}

	clearActions(): void {
		this.actions.length = 0;
	}

	releasePending(): void {
		for (const listener of this.listeners) {
			clearTimeout(listener.timer);
			listener.reject(new Error('MockApiHandler released pending waitForAction listeners during close().'));
		}
		this.listeners = [];
		for (const entry of this.gates) entry.release();
		this.gates = [];
	}

	private matchParams(
		matcher: RouteMatcher,
		action: Pick<RecordedAction, 'method' | 'route'>,
	): Record<string, string> | undefined {
		if (matcher.method !== action.method) return undefined;
		let compiled = this.routeCache.get(matcher.route);
		if (!compiled) {
			compiled = compileRoute(matcher.route);
			this.routeCache.set(matcher.route, compiled);
		}
		const { pattern, names } = compiled;
		const match = pattern.exec(action.route);
		if (!match) return undefined;
		const params: Record<string, string> = {};
		names.forEach((name, index) => {
			params[name] = match[index + 1];
		});
		return params;
	}

	matches(matcher: RouteMatcher, action: Pick<RecordedAction, 'method' | 'route'>): boolean {
		return this.matchParams(matcher, action) !== undefined;
	}

	private filterMatches(action: RecordedAction, filter: ActionFilter, params: Record<string, string>): boolean {
		if (filter.method && filter.method !== action.method) return false;
		const capturedRouteParams = this.filterParams(action, filter);
		const routeParams = { ...params, ...capturedRouteParams };
		if (filter.route !== undefined) {
			if (typeof filter.route === 'string') {
				if (filter.route.includes(':') && Object.keys(capturedRouteParams).length === 0) return false;
				if (!filter.route.includes(':') && filter.route !== action.route) return false;
			}
			if (filter.route instanceof RegExp && !filter.route.test(action.route)) return false;
			if (typeof filter.route === 'function' && !filter.route(action.route, action)) return false;
		}
		if (filter.params && Object.entries(filter.params).some(([key, value]) => routeParams[key] !== value)) return false;
		if (!matchesValue(action.body, filter.body, action)) return false;
		if (!matchesValue(action.query, filter.query, action)) return false;
		if (!matchesValue(action.files, filter.files, action)) return false;
		if (!matchesValue(action.reason, filter.reason, action)) return false;
		if (!matchesValue(action.response, filter.response, action)) return false;
		if (!matchesError(action.error, filter.error, action)) return false;
		return true;
	}

	private filterParams(action: RecordedAction, filter: ActionFilter): Record<string, string> {
		if (typeof filter.route !== 'string' || !filter.route.includes(':')) return {};
		return this.matchParams({ method: filter.method ?? action.method, route: filter.route }, action) ?? {};
	}

	findCalls(matcher: RouteMatcher | ActionPredicate, params?: Record<string, string>): MatchedAction[];
	findCalls(matcher: RouteMatcher, filter: RouteActionFilter): MatchedAction[];
	findCalls(matcher: ActionFilter | ActionPredicate): MatchedAction[];
	findCalls(matcher: ActionMatcher, paramsOrFilter?: Record<string, string> | RouteActionFilter): MatchedAction[];
	findCalls(matcher: ActionMatcher, paramsOrFilter?: Record<string, string> | RouteActionFilter): MatchedAction[] {
		const out: MatchedAction[] = [];
		for (const action of this.actions) {
			if (typeof matcher === 'function') {
				if (matcher(action)) out.push({ ...action, params: {} });
				continue;
			}

			if (!isRouteMatcherOnly(matcher)) {
				if (this.filterMatches(action, matcher, {}))
					out.push({ ...action, params: this.filterParams(action, matcher) });
				continue;
			}

			const captured = this.matchParams(matcher, action);
			if (!captured) continue;
			if (!this.filterMatches(action, normalizeRouteActionFilter(paramsOrFilter), captured)) continue;
			out.push({ ...action, params: captured });
		}
		return out;
	}

	findCall(matcher: RouteMatcher | ActionPredicate, params?: Record<string, string>): MatchedAction | undefined;
	findCall(matcher: RouteMatcher, filter: RouteActionFilter): MatchedAction | undefined;
	findCall(matcher: ActionFilter | ActionPredicate): MatchedAction | undefined;
	findCall(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined;
	findCall(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined {
		return this.findCalls(matcher, paramsOrFilter)[0];
	}

	waitForAction(matcher: RouteMatcher | ActionFilter, timeoutMs?: number): Promise<MatchedAction>;
	waitForAction(predicate: ActionPredicate, timeoutMs?: number): Promise<MatchedAction>;
	waitForAction(
		matcherOrPredicate: RouteMatcher | ActionFilter | ActionPredicate,
		timeoutMs = 2000,
	): Promise<MatchedAction> {
		return this.listenForAction(matcherOrPredicate, timeoutMs, 'settled');
	}

	private listenForAction(
		matcherOrPredicate: RouteMatcher | ActionFilter | ActionPredicate,
		timeoutMs: number,
		resolveOn: NotifyPhase,
	): Promise<MatchedAction> {
		const enrich = (action: RecordedAction): MatchedAction => {
			if (typeof matcherOrPredicate === 'function') return { ...action, params: {} };
			if (isRouteMatcherOnly(matcherOrPredicate)) {
				return { ...action, params: this.matchParams(matcherOrPredicate, action) ?? {} };
			}
			return { ...action, params: this.filterParams(action, matcherOrPredicate) };
		};
		const predicate =
			typeof matcherOrPredicate === 'function'
				? matcherOrPredicate
				: isRouteMatcherOnly(matcherOrPredicate)
					? (action: RecordedAction) => this.matches(matcherOrPredicate, action)
					: (action: RecordedAction) => this.filterMatches(action, matcherOrPredicate, {});

		const existing = this.actions.find(predicate);
		if (existing) return Promise.resolve(enrich(existing));

		return new Promise((resolve, reject) => {
			let listener!: ActionListener;
			listener = {
				timer: setTimeout(() => {
					this.listeners = this.listeners.filter(entry => entry !== listener);
					const seen = this.actions.map(action => `${action.method} ${action.route}`).join('\n  ') || '(none)';
					reject(new Error(`waitForAction timed out after ${timeoutMs}ms. Actions seen:\n  ${seen}`));
				}, timeoutMs),
				reject,
				onAction: (action: RecordedAction, phase: NotifyPhase) => {
					if (phase !== resolveOn) return;
					if (!predicate(action)) return;
					clearTimeout(listener.timer);
					this.listeners = this.listeners.filter(entry => entry !== listener);
					resolve(enrich(action));
				},
			};
			this.listeners.push(listener);
		});
	}

	gateNext(matcher?: RouteMatcher | ActionFilter | ActionPredicate): {
		hit: Promise<RecordedAction>;
		release: () => void;
	} {
		const g = gate();
		const startSeq = this.seq;
		const test = (action: RecordedAction) =>
			action.seq >= startSeq &&
			(!matcher ||
				(typeof matcher === 'function'
					? matcher(action)
					: isRouteMatcherOnly(matcher)
						? this.matches(matcher, action)
						: this.filterMatches(action, matcher, {})));
		const entry = { test, hold: () => g.open, release: g.release };
		this.gates.push(entry);
		const hit = this.listenForAction(test, 2000, 'pending').finally(() => {
			this.gates = this.gates.filter(other => other !== entry);
			g.release();
		});
		return { hit, release: g.release };
	}

	private notifyListeners(action: RecordedAction, phase: NotifyPhase): void {
		for (const listener of [...this.listeners]) listener.onAction(action, phase);
	}

	async request<T = unknown>(
		method: HttpMethods,
		url: `/${string}`,
		requestOptions: ApiRequestOptions = {},
	): Promise<T> {
		const pending: PendingAction = {
			method,
			route: url,
			body: requestOptions.body,
			query: requestOptions.query,
			files: requestOptions.files,
			reason: requestOptions.reason,
		};
		const action: RecordedAction = { seq: this.seq++, ...pending, response: undefined };
		this.actions.push(action);
		this.notifyListeners(action, 'pending');

		for (const entry of [...this.gates]) {
			if (entry.test(action)) {
				this.gates = this.gates.filter(other => other !== entry);
				await entry.hold();
			}
		}

		try {
			const response = await this.resolveResponse(pending);
			action.response = response;
			this.notifyListeners(action, 'settled');
			return response as T;
		} catch (error) {
			action.error = error;
			this.notifyListeners(action, 'settled');
			throw error;
		}
	}

	private resolveResponse(pending: PendingAction): unknown {
		for (const interceptor of this.interceptors) {
			if (interceptor.method !== pending.method) continue;
			const match = interceptor.pattern.exec(pending.route);
			if (!match) continue;
			const params: Record<string, string> = {};
			interceptor.names.forEach((name, index) => {
				params[name] = match[index + 1];
			});
			return interceptor.responder(pending, params);
		}

		if (pending.method === 'GET') {
			if (/\/(messages|bans|roles|channels|pins|invites|emojis|stickers|members)(\?|$)/.test(pending.route)) {
				this.reportUnhandled(pending);
				return [];
			}
			if (/\/reactions\//.test(pending.route)) {
				this.reportUnhandled(pending);
				return [];
			}
			if (/\/threads\/(archived|active)/.test(pending.route)) {
				this.reportUnhandled(pending);
				return { threads: [], members: [] };
			}
			if (/\/messages\/[^/]+$/.test(pending.route)) {
				if (!/\/webhooks\//.test(pending.route)) this.reportUnhandled(pending);
				return apiMessage();
			}
			if (!/\/webhooks\//.test(pending.route)) this.reportUnhandled(pending);
			return {};
		}

		if (pending.method === 'POST' || pending.method === 'PATCH') {
			const ids = /\/channels\/([^/]+)\/messages\/([^/]+)$/.exec(pending.route);
			return {
				...apiMessage(ids ? { channelId: ids[1], id: ids[2] } : {}),
				...definedBody(pending.body),
			};
		}
		return {};
	}
}
