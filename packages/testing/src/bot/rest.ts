import { ApiHandler } from 'seyfert';
import type { ApiRequestOptions, HttpMethods } from 'seyfert/lib/api/shared';
import { dispatchStore } from './dispatch-context';
import { apiMessage } from './payloads';
import { CHANNEL_MESSAGE_POST, Routes, WEBHOOK_EXECUTE_POST } from './routes';

export interface RecordedAction {
	seq: number;
	/** Dispatch that produced this action, for per-dispatch attribution under concurrency. */
	dispatchId?: number;
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
	return (
		action.method === 'POST' && (CHANNEL_MESSAGE_POST.test(action.route) || WEBHOOK_EXECUTE_POST.test(action.route))
	);
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

/** Named Discord JSON error codes used by the mock's fail-loud guards, so no call site spells a bare number. */
export const ErrorCode = {
	UnknownChannel: 10003,
	UnknownGuild: 10004,
	UnknownMember: 10007,
	UnknownMessage: 10008,
	UnknownWebhook: 10015,
	UnknownBan: 10026,
	MaxPinnedMessages: 30003,
	CannotEditAnotherUsersMessage: 50005,
	CannotSendEmptyMessage: 50006,
	MissingPermissions: 50013,
	CannotExecuteOnChannelType: 50024,
	InvalidFormBody: 50035,
	ThreadArchived: 50083,
} as const;

export function apiError(status: number, code: number, message: string): never {
	throw new MockApiError(status, code, message);
}

export interface DiscordErrorInit {
	status: number;
	statusText?: string;
	code?: number;
	message?: string;
	retryAfter?: number;
}

const STATUS_TEXT: Record<number, string> = {
	400: 'Bad Request',
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	429: 'Too Many Requests',
	500: 'Internal Server Error',
};

/**
 * A small set of common Discord REST errors for {@link MockApiHandler.fail}. The raw
 * {@link DiscordErrorInit} shape is the primary contract — spread/override these or pass your own
 * for anything off this list. statusText is derived from status (see STATUS_TEXT).
 */
export const DiscordErrors = {
	MissingPermissions: { status: 403, code: 50013, message: 'Missing Permissions' },
	MissingAccess: { status: 403, code: 50001, message: 'Missing Access' },
	UnknownGuild: { status: 404, code: 10004, message: 'Unknown Guild' },
	UnknownChannel: { status: 404, code: 10003, message: 'Unknown Channel' },
	UnknownMessage: { status: 404, code: 10008, message: 'Unknown Message' },
	UnknownMember: { status: 404, code: 10007, message: 'Unknown Member' },
	UnknownBan: { status: 404, code: 10026, message: 'Unknown Ban' },
	CannotEditAnotherUsersMessage: {
		status: 403,
		code: 50005,
		message: 'Cannot edit a message authored by another user',
	},
	RateLimited: { status: 429, code: 0, message: 'You are being rate limited.' },
} as const satisfies Record<string, DiscordErrorInit>;

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

/**
 * {@link MatchedAction} with caller-supplied types for the request `body` and `response`, so assertions
 * off a matched call don't need a cast. The generics are erased at runtime; the library casts internally.
 */
export type TypedMatchedAction<TBody = Record<string, unknown>, TResponse = unknown> = Omit<
	MatchedAction,
	'body' | 'response'
> & { body?: TBody; response: TResponse };

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

const MODELED_ROUTES: { method: HttpMethods; pattern: RegExp }[] = Object.values(Routes).map(route => ({
	method: route.method,
	pattern: compileRoute(route.route).pattern,
}));

function matchesModeledRoute(method: HttpMethods, route: string): boolean {
	return MODELED_ROUTES.some(entry => entry.method === method && entry.pattern.test(route));
}

/**
 * Declarative shapes for synthetic GET fallbacks (an unhandled GET that matches no interceptor). First
 * matching row wins; routes with no row default to `{}`. `webhookExempt` rows do NOT report-unhandled for
 * `/webhooks/` routes (interaction-response reads legitimately fall through to a synthetic) — the default
 * (no row) is also webhook-exempt. Collection reads warn unconditionally.
 */
const SYNTHETIC_GET_SHAPES: { pattern: RegExp; shape: () => unknown; webhookExempt?: boolean }[] = [
	{ pattern: /\/(messages|bans|roles|channels|pins|invites|emojis|stickers|members)(\?|$)/, shape: () => [] },
	{ pattern: /\/reactions\//, shape: () => [] },
	{ pattern: /\/threads\/(archived|active)/, shape: () => ({ threads: [], members: [] }) },
	{ pattern: /\/messages\/[^/]+$/, shape: () => apiMessage(), webhookExempt: true },
];

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

/** Single source for the route-filter keys; `satisfies` makes a new RouteActionFilter field a compile error until listed. */
const ROUTE_FILTER_KEYS = {
	params: true,
	body: true,
	query: true,
	files: true,
	reason: true,
	response: true,
	error: true,
} satisfies Record<keyof RouteActionFilter, true>;

function hasRouteFilterKeys(value: Record<string, unknown>): boolean {
	return Object.keys(ROUTE_FILTER_KEYS).some(key => key in value);
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
	/** In-flight request counts keyed by dispatchId (0 = no active dispatch). */
	private readonly inFlight = new Map<number, number>();
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
			`[@slipher/testing] no interceptor or world entity matched ${pending.method} ${pending.route} - ` +
			`answered with a synthetic fallback. Seed the world, stub it with intercept(), ` +
			`or pass onUnhandledRest: 'silent' to createMockBot.`;
		if (this.unhandled === 'error') throw new Error(message);
		const key = `${pending.method} ${pending.route}`;
		if (this.warnedRoutes.has(key)) return;
		this.warnedRoutes.add(key);
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
	 * Make a route reject with a Discord-faithful {@link SeyfertError} (built via the same
	 * parseError the real ApiHandler uses), so a command's own error handling runs. Persistent
	 * until the returned disposer or reset() clears it; pass { times } to fail the first N matching
	 * calls then fall through to normal handling. For sequential or request-conditional failures,
	 * use intercept() with a closure counter.
	 */
	fail(matcher: RouteMatcher, error: DiscordErrorInit, opts?: { times?: number }): () => void {
		let n = 0;
		const off = this.intercept(matcher, () => {
			if (opts?.times !== undefined && ++n >= opts.times) off();
			throw this.discordError(matcher.method, matcher.route, error);
		});
		return off;
	}

	private discordError(method: HttpMethods, route: string, error: DiscordErrorInit): unknown {
		const statusText = error.statusText ?? STATUS_TEXT[error.status] ?? '';
		const body: Record<string, unknown> = { code: error.code ?? 0, message: error.message ?? statusText };
		if (error.retryAfter !== undefined) body.retry_after = error.retryAfter;
		return this.parseError(
			method,
			route as `/${string}`,
			{ status: error.status, statusText } as unknown as Response,
			body,
			undefined,
		);
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

	findCalls<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher | ActionPredicate,
		params?: Record<string, string>,
	): TypedMatchedAction<TBody, TResponse>[];
	findCalls<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher,
		filter: RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse>[];
	findCalls<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionFilter | ActionPredicate,
	): TypedMatchedAction<TBody, TResponse>[];
	findCalls<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse>[];
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

	findCall<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher | ActionPredicate,
		params?: Record<string, string>,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findCall<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher,
		filter: RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findCall<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionFilter | ActionPredicate,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findCall<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): TypedMatchedAction<TBody, TResponse> | undefined;
	findCall(
		matcher: ActionMatcher,
		paramsOrFilter?: Record<string, string> | RouteActionFilter,
	): MatchedAction | undefined {
		return this.findCalls(matcher, paramsOrFilter)[0];
	}

	waitForAction<TBody = Record<string, unknown>, TResponse = unknown>(
		matcher: RouteMatcher | ActionFilter,
		timeoutMs?: number,
	): Promise<TypedMatchedAction<TBody, TResponse>>;
	waitForAction<TBody = Record<string, unknown>, TResponse = unknown>(
		predicate: ActionPredicate,
		timeoutMs?: number,
	): Promise<TypedMatchedAction<TBody, TResponse>>;
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

	gateNext(
		matcher?: RouteMatcher | ActionFilter | ActionPredicate,
		dispatchId?: number,
	): {
		hit: Promise<RecordedAction>;
		release: () => void;
	} {
		const g = gate();
		const startSeq = this.seq;
		const test = (action: RecordedAction) =>
			action.seq >= startSeq &&
			(dispatchId === undefined || action.dispatchId === dispatchId) &&
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
		const dispatchId = dispatchStore.getStore()?.dispatchId ?? 0;
		const action: RecordedAction = { seq: this.seq++, dispatchId, ...pending, response: undefined };
		this.actions.push(action);
		this.inFlight.set(dispatchId, (this.inFlight.get(dispatchId) ?? 0) + 1);
		this.notifyListeners(action, 'pending');

		try {
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
		} finally {
			const remaining = (this.inFlight.get(dispatchId) ?? 1) - 1;
			if (remaining > 0) this.inFlight.set(dispatchId, remaining);
			else this.inFlight.delete(dispatchId);
		}
	}

	/**
	 * Number of REST requests currently between request() entry and settlement (includes gated/parked requests).
	 * With a dispatchId, counts only that dispatch's requests; without, the global total.
	 */
	pendingRequestCount(dispatchId?: number): number {
		if (dispatchId !== undefined) return this.inFlight.get(dispatchId) ?? 0;
		let total = 0;
		for (const count of this.inFlight.values()) total += count;
		return total;
	}

	hasPendingRequests(dispatchId?: number): boolean {
		if (dispatchId !== undefined) return (this.inFlight.get(dispatchId) ?? 0) > 0;
		return this.inFlight.size > 0;
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

		// No interceptor handled a request that matches a modeled Route: surface the gap
		// (respecting onUnhandledRest) instead of silently answering with a synthetic.
		if (matchesModeledRoute(pending.method, pending.route)) {
			this.reportUnhandled(pending);
			return this.syntheticResponse(pending);
		}

		return this.syntheticResponse(pending);
	}

	private syntheticResponse(pending: PendingAction): unknown {
		if (pending.method === 'GET') {
			const entry = SYNTHETIC_GET_SHAPES.find(row => row.pattern.test(pending.route));
			const webhookExempt = entry?.webhookExempt ?? true;
			if (!webhookExempt || !/\/webhooks\//.test(pending.route)) this.reportUnhandled(pending);
			return entry ? entry.shape() : {};
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
