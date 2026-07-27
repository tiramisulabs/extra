import { ApiHandler, type ApiRequestOptions, type HttpMethods } from 'seyfert';
import { dispatchStore } from './dispatch-context';
import { apiMessage } from './payloads';
import { CHANNEL_MESSAGE_POST, WEBHOOK_EXECUTE_POST } from './routes';

// Capture the real setTimeout/clearTimeout at module load so internal action/gate control timeouts run on the
// wall clock even when a test fakes global timers (vi.useFakeTimers replaces globalThis.setTimeout). Otherwise
// the deadline would freeze (until() hangs) or be tripped spuriously by advanceTime().
const realSetTimeout = setTimeout.bind(globalThis);
const realClearTimeout = clearTimeout.bind(globalThis);

export interface RecordedAction {
	seq: number;
	/** Dispatch that produced this action, for per-dispatch attribution under concurrency. */
	dispatchId?: number;
	/** Stateful actor/session that produced this action. Absent for raw and out-of-band REST. */
	sessionKey?: string;
	method: HttpMethods;
	route: string;
	body?: Record<string, unknown>;
	query?: Record<string, unknown>;
	files?: unknown[];
	/** Audit-log reason, when the command passed one. */
	reason?: string;
	/** True once the responder finished, even when the response itself is undefined. */
	settled: boolean;
	/** The responder's result; may legitimately be undefined after settlement. */
	response: unknown;
	/** The responder error; set before the original error is rethrown. */
	error?: unknown;
	/** True when the responder fabricated this response (no real entity/collection backed it). */
	synthetic?: boolean;
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

interface ApiObserverNotifier {
	notifyRequest(method: HttpMethods, url: `/${string}`, request: ApiRequestOptions): Promise<void>;
	notifySuccessRequest(
		method: HttpMethods,
		url: `/${string}`,
		response: Response,
		request: ApiRequestOptions,
	): Promise<void>;
	notifyFailRequest(
		method: HttpMethods,
		url: `/${string}`,
		error: unknown,
		statusCode: number | undefined,
		request: ApiRequestOptions,
	): Promise<void>;
	notifyRatelimit(
		response: Response,
		request: ApiRequestOptions,
		method: HttpMethods,
		url: `/${string}`,
	): Promise<void>;
}

/**
 * Throw a Discord REST error, naming it from the one catalog.
 *
 * Takes a {@link DiscordErrors} entry rather than a loose status/code/message triple, because a triple has to
 * be restated at every call site and there were a hundred of them — one wrong copy and the code no longer
 * matches the message. `message` overrides the catalog's copy for the errors whose text is per-call, like
 * Invalid Form Body naming the offending field.
 */
export function apiError(error: DiscordErrorInit, message?: string): never {
	throw new MockApiError(
		error.status,
		error.code ?? 0,
		message ?? error.message ?? STATUS_TEXT[error.status] ?? 'Unknown Error',
	);
}

/**
 * Narrow an unknown caught value to a Discord REST error, whichever shape it arrived in.
 *
 * `rest.fail()` produces seyfert's own error (it routes through the real `ApiHandler.parseError`), while the
 * world guards throw the package's `MockApiError`; both are Discord errors as far as a test is concerned, and
 * neither was narrowable without knowing which one to expect.
 *
 * ```ts
 * catch (error) {
 *   if (isDiscordError(error, { code: DiscordErrors.UnknownMessage.code })) return;
 *   throw error;
 * }
 * ```
 */
export function isDiscordError(value: unknown, match: { status?: number; code?: number } = {}): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const status = statusOf(value);
	const code = codeOf(value);
	if (status === undefined && code === undefined) return false;
	if (match.status !== undefined && match.status !== status) return false;
	if (match.code !== undefined && match.code !== code) return false;
	return true;
}

function statusOf(value: object): number | undefined {
	const direct = (value as { status?: unknown }).status;
	if (typeof direct === 'number') return direct;
	const response = (value as { metadata?: { response?: { status?: unknown } } }).metadata?.response;
	return typeof response?.status === 'number' ? response.status : undefined;
}

function codeOf(value: object): number | undefined {
	const direct = (value as { code?: unknown }).code;
	if (typeof direct === 'number') return direct;
	// seyfert stringifies the code into `API_<statusText>_<code>`; the body it parsed still holds the number.
	const body = (value as { metadata?: { response?: { code?: unknown } } }).metadata?.response;
	if (typeof body?.code === 'number') return body.code;
	const match = typeof direct === 'string' ? /_(\d+)$/.exec(direct) : undefined;
	return match ? Number(match[1]) : undefined;
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
	UnknownUser: { status: 404, code: 10013, message: 'Unknown User' },
	UnknownMember: { status: 404, code: 10007, message: 'Unknown Member' },
	UnknownBan: { status: 404, code: 10026, message: 'Unknown Ban' },
	UnknownWebhook: { status: 404, code: 10015, message: 'Unknown Webhook' },
	UnknownInvite: { status: 404, code: 10006, message: 'Unknown Invite' },
	UnknownGuildTemplate: { status: 404, code: 10057, message: 'Unknown Guild Template' },
	UnknownRole: { status: 404, code: 10011, message: 'Unknown Role' },
	UnknownEmoji: { status: 404, code: 10014, message: 'Unknown Emoji' },
	UnknownSticker: { status: 404, code: 10060, message: 'Unknown Sticker' },
	UnknownStageInstance: { status: 404, code: 10067, message: 'Unknown Stage Instance' },
	UnknownScheduledEvent: { status: 404, code: 180000, message: 'Unknown Guild Scheduled Event' },
	CannotEditAnotherUsersMessage: {
		status: 403,
		code: 50005,
		message: 'Cannot edit a message authored by another user',
	},
	RateLimited: { status: 429, code: 0, message: 'You are being rate limited.' },
	MaxPinnedMessages: { status: 400, code: 30003, message: 'Maximum number of pinned messages reached (50)' },
	CannotSendEmptyMessage: { status: 400, code: 50006, message: 'Cannot send an empty message' },
	CannotExecuteOnChannelType: { status: 400, code: 50024, message: 'Cannot execute action on this channel type' },
	InvalidFormBody: { status: 400, code: 50035, message: 'Invalid Form Body' },
	ThreadArchived: { status: 400, code: 50083, message: 'Thread is archived' },
	AlreadyAcknowledged: { status: 400, code: 40060, message: 'Interaction has already been acknowledged.' },
} as const satisfies Record<string, DiscordErrorInit>;

/** Returned by an interceptor that declines this call, so `resolveResponse` keeps looking. Never observable. */
const PASS_TO_NEXT = Symbol('slipher.testing.passToNext');

export function gate(): { open: Promise<void>; release: () => void } {
	let release!: () => void;
	const open = new Promise<void>(resolve => {
		release = resolve;
	});
	return { open, release };
}

export type PendingAction = Omit<RecordedAction, 'response' | 'seq' | 'settled'>;

export type RouteResponder = (action: PendingAction, params: Record<string, string>) => unknown;

export type RouteParamNames<TRoute extends string> = TRoute extends `${string}:${infer TParam}/${infer TRest}`
	? TParam | RouteParamNames<`/${TRest}`>
	: TRoute extends `${string}:${infer TParam}`
		? TParam
		: never;

export type RouteParams<TRoute extends string> = [RouteParamNames<TRoute>] extends [never]
	? Record<string, never>
	: Record<RouteParamNames<TRoute>, string>;

declare const routeContract: unique symbol;

export interface RouteMatcher<TRoute extends string = string, TBody = unknown, TResponse = unknown> {
	method: HttpMethods;
	route: TRoute;
	/** Type-only request/response carrier; route descriptors have no corresponding runtime field. */
	readonly [routeContract]?: {
		body: TBody;
		response: TResponse;
	};
}

/** A read-only REST snapshot, enriched with params captured from the supplied route descriptor. */
export type RestCall<
	TParams extends Record<string, string | undefined> = Record<string, undefined>,
	TBody = Record<string, unknown>,
	TResponse = unknown,
> = Readonly<
	Omit<RecordedAction, 'body' | 'response'> & {
		params: TParams;
		body?: TBody;
		response: TResponse | undefined;
	}
>;

/** Read the bot's or actor's complete REST history, optionally narrowed by one route descriptor. */
export interface RestCalls {
	(): readonly RestCall[];
	<TRoute extends string, TBody, TResponse>(
		matcher: RouteMatcher<TRoute, TBody, TResponse>,
	): readonly RestCall<RouteParams<TRoute>, TBody, TResponse>[];
}

export type ActionPredicate = (action: RecordedAction) => boolean;

interface Interceptor {
	method: HttpMethods;
	pattern: RegExp;
	names: string[];
	sourceRoute?: string;
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

/**
 * Compiled patterns keyed by route template. Module-scoped rather than per-handler: templates are static
 * strings from route descriptors, so the set is finite and shared safely across bots and standalone matching.
 */
const routeCache = new Map<string, { pattern: RegExp; names: string[] }>();

function compiledRoute(route: string): { pattern: RegExp; names: string[] } {
	let compiled = routeCache.get(route);
	if (!compiled) {
		compiled = compileRoute(route);
		routeCache.set(route, compiled);
	}
	return compiled;
}

/**
 * Extract a route descriptor's params from a recorded call, or `undefined` when the call does not match it.
 *
 * The matcher is domain-neutral — an HTTP method plus a `:param` path template — so this is the piece needed
 * to reuse `defineRoute`/`RestCall`/`RestCalls` for an API the package does not own, without constructing a
 * bot just to borrow `MockApiHandler`'s copy.
 *
 * Templates are **path-only and query-free**, mirroring {@link RecordedAction}, which keeps `route` and
 * `query` apart. An origin inside `route` breaks in three inconsistent ways: `RouteParamNames` reads `:` as a
 * param marker (`https://…` yields an empty name, a `:8080` port yields `8080`), `compileRoute` collapses the
 * `//` and finds no params, and `routeUrl` demands the port as one. Keep the origin on the caller's side.
 */
export function matchRoute<TRoute extends string>(
	matcher: RouteMatcher<TRoute>,
	call: Pick<RecordedAction, 'method' | 'route'>,
): RouteParams<TRoute> | undefined {
	if (matcher.method !== call.method) return undefined;
	const { pattern, names } = compiledRoute(matcher.route);
	const match = pattern.exec(call.route);
	if (!match) return undefined;
	const params: Record<string, string> = {};
	names.forEach((name, index) => {
		params[name] = match[index + 1];
	});
	return params as RouteParams<TRoute>;
}

export function routeUrl<TRoute extends string>(
	matcher: RouteMatcher<TRoute>,
	params: RouteParams<TRoute>,
): `/${string}` {
	const route = matcher.route.replace(/:([^/]+)/g, (_, name: string) => {
		const value = (params as Record<string, string | undefined>)[name];
		if (value === undefined) {
			throw new TypeError(`routeUrl: missing route param "${name}" for ${matcher.method} ${matcher.route}.`);
		}
		return encodeURIComponent(value);
	});
	return route as `/${string}`;
}

const REDACTED_ROUTE_TOKEN = ':token';
const WEBHOOK_TOKEN_SEGMENT = /(\/webhooks\/[^/?#]+\/)[^/?#]+/g;
const INTERACTION_CALLBACK_TOKEN_SEGMENT = /(\/interactions\/[^/?#]+\/)[^/?#]+(?=\/callback(?:[/?#]|$))/g;

/** Redact Discord credential-bearing path segments while preserving a useful diagnostic route shape. */
export function redactRouteTokens(route: string): string {
	return route
		.replace(WEBHOOK_TOKEN_SEGMENT, `$1${REDACTED_ROUTE_TOKEN}`)
		.replace(INTERACTION_CALLBACK_TOKEN_SEGMENT, `$1${REDACTED_ROUTE_TOKEN}`);
}

/**
 * Declarative shapes for synthetic GET fallbacks (an unhandled GET that matches no interceptor). First
 * matching row wins; routes with no row default to `{}`.
 */
const SYNTHETIC_GET_SHAPES: { pattern: RegExp; shape: () => unknown }[] = [
	{ pattern: /\/(messages|bans|roles|channels|pins|invites|emojis|stickers|members)(\?|$)/, shape: () => [] },
	{ pattern: /\/reactions\//, shape: () => [] },
	{ pattern: /\/threads\/(archived|active)/, shape: () => ({ threads: [], members: [] }) },
	{ pattern: /\/messages\/[^/]+$/, shape: () => apiMessage() },
];

function definedBody(body: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!body) return {};
	return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return String(value);
		return text.length > 240 ? `${text.slice(0, 237)}...` : text;
	} catch {
		return String(value);
	}
}

export class MockApiHandler extends ApiHandler {
	/** @internal */
	readonly actions: RecordedAction[] = [];
	private listeners: ActionListener[] = [];
	private interceptors: Interceptor[] = [];
	private defaultInterceptors: Interceptor[] = [];
	private gates: RequestGate[] = [];
	private seq = 0;
	/** Exact in-flight actions; dispatchId 0 denotes a request made outside an active dispatch. */
	private readonly inFlight = new Set<RecordedAction>();
	private readonly unhandled: 'warn' | 'error' | 'silent';
	private readonly warnedRoutes = new Set<string>();
	/** Response objects a responder fabricated; used to stamp RecordedAction.synthetic. */
	private readonly syntheticResponses = new WeakSet<object>();

	constructor(options: { onUnhandledRest?: 'warn' | 'error' | 'silent' } = {}) {
		super({ token: 'slipher-mock-token' });
		this.unhandled = options.onUnhandledRest ?? 'error';
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
		const interceptor: Interceptor = {
			method: methodOrMatcher,
			...compiled,
			...(typeof routeOrResponder === 'string' ? { sourceRoute: routeOrResponder } : {}),
			responder,
		};
		this.interceptors.unshift(interceptor);
		return () => {
			const index = this.interceptors.indexOf(interceptor);
			if (index !== -1) this.interceptors.splice(index, 1);
		};
	}

	/**
	 * Tag a fabricated response so the recorded action is stamped `synthetic: true`. A responder calls this on
	 * a value it invented (no real entity/collection backed it), letting a test tell a genuine result from a
	 * plausible-looking fallback. Returns the value unchanged for inline use.
	 */
	markSynthetic<T>(value: T): T {
		if (value !== null && typeof value === 'object') this.syntheticResponses.add(value as object);
		return value;
	}

	/**
	 * Make a route reject with a Discord-faithful {@link SeyfertError} (built via the same
	 * parseError the real ApiHandler uses), so a command's own error handling runs. Persistent
	 * until the returned disposer or reset() clears it; pass { times } to fail the first N matching
	 * calls then fall through to normal handling. For sequential or request-conditional failures,
	 * use intercept() with a closure counter.
	 */
	fail(
		matcher: RouteMatcher,
		error: DiscordErrorInit,
		opts?: {
			/** Fail the first N matching calls, then fall through to normal handling. */
			times?: number;
			/**
			 * Fail only the calls this answers true for — the Nth, the ones whose body matches, the ones for
			 * one guild. `times` alone could only express "the first N", so anything else meant reaching for
			 * `intercept()` with a closure counter, which cannot throw this error at all: the builder is
			 * private and the exported thrower produces the package's own class, not the faithful one.
			 */
			when?: (action: PendingAction, params: Record<string, string>) => boolean;
		},
	): () => void {
		let n = 0;
		const off = this.intercept(matcher, (action, params) => {
			if (opts?.when && !opts.when(action, params)) return PASS_TO_NEXT;
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

	hasInterceptor(matcher: RouteMatcher): boolean {
		return this.interceptors.some(
			interceptor => interceptor.method === matcher.method && interceptor.sourceRoute === matcher.route,
		);
	}

	clearActions(): void {
		this.actions.length = 0;
	}

	releasePending(): void {
		for (const listener of this.listeners) {
			realClearTimeout(listener.timer);
			listener.reject(new Error('MockApiHandler released pending action listeners during close().'));
		}
		this.listeners = [];
		for (const entry of this.gates) entry.release();
		this.gates = [];
	}

	/** @internal One-line delegation kept for the dispatcher's own route reads; tests use `matchRoute`. */
	matchRouteParams<TRoute extends string>(
		matcher: RouteMatcher<TRoute>,
		action: Pick<RecordedAction, 'method' | 'route'>,
	): RouteParams<TRoute> | undefined {
		return matchRoute(matcher, action);
	}

	/** @internal One-line delegation kept for the journal filters below; tests use `matchRoute`. */
	matches(matcher: RouteMatcher, action: Pick<RecordedAction, 'method' | 'route'>): boolean {
		return matchRoute(matcher, action) !== undefined;
	}

	/** @internal Temporal coordination for dispatch machinery; user assertions belong to bot.restCalls(). */
	waitUntilAction(matcherOrPredicate: RouteMatcher | ActionPredicate, timeoutMs = 2000): Promise<RecordedAction> {
		return this.listenForAction(matcherOrPredicate, timeoutMs, 'settled');
	}

	/** @internal One-line delegation kept for `request(matcher, params)`; tests use the free `routeUrl`. */
	routeUrl<TRoute extends string>(matcher: RouteMatcher<TRoute>, params: RouteParams<TRoute>): `/${string}` {
		return routeUrl(matcher, params);
	}

	call<T = unknown, TRoute extends string = string>(
		matcher: RouteMatcher<TRoute>,
		params: RouteParams<TRoute>,
		requestOptions: ApiRequestOptions = {},
	): Promise<T> {
		return this.request<T>(matcher.method, this.routeUrl(matcher, params), requestOptions);
	}

	private actionsSeen(): string {
		if (this.actions.length === 0) return '  (none)';
		return this.actions.map(action => `  ${this.describeAction(action)}`).join('\n');
	}

	private describeMatcher(matcher: RouteMatcher | ActionPredicate): string {
		if (typeof matcher === 'function') return '(predicate)';
		return `${matcher.method} ${matcher.route}`;
	}

	private describeAction(action: RecordedAction): string {
		const parts = [`#${action.seq}`, `${action.method} ${action.route}`];
		if (Object.keys(action.body ?? {}).length) parts.push(`body=${compact(action.body)}`);
		if (Object.keys(action.query ?? {}).length) parts.push(`query=${compact(action.query)}`);
		if (action.response !== undefined || action.settled) parts.push(`response=${compact(action.response)}`);
		if (action.error !== undefined) parts.push(`error=${compact(action.error)}`);
		return parts.join(' ');
	}

	private listenForAction(
		matcherOrPredicate: RouteMatcher | ActionPredicate,
		timeoutMs: number,
		resolveOn: NotifyPhase,
	): Promise<RecordedAction> {
		const predicate =
			typeof matcherOrPredicate === 'function'
				? matcherOrPredicate
				: (action: RecordedAction) => this.matches(matcherOrPredicate, action);

		const existing = this.actions.find(
			action => predicate(action) && (resolveOn === 'pending' || action.settled || action.error !== undefined),
		);
		if (existing) return Promise.resolve(existing);

		return new Promise((resolve, reject) => {
			let listener!: ActionListener;
			listener = {
				timer: realSetTimeout(() => {
					this.listeners = this.listeners.filter(entry => entry !== listener);
					reject(
						new Error(
							`Action wait timed out after ${timeoutMs}ms waiting for ${this.describeMatcher(
								matcherOrPredicate,
							)}. Actions seen:\n${this.actionsSeen()}`,
						),
					);
				}, timeoutMs),
				reject,
				onAction: (action: RecordedAction, phase: NotifyPhase) => {
					if (phase !== resolveOn) return;
					if (!predicate(action)) return;
					realClearTimeout(listener.timer);
					this.listeners = this.listeners.filter(entry => entry !== listener);
					resolve(action);
				},
			};
			this.listeners.push(listener);
		});
	}

	gateNext(
		matcher?: RouteMatcher | ActionPredicate,
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
			(!matcher || (typeof matcher === 'function' ? matcher(action) : this.matches(matcher, action)));
		const entry = { test, hold: () => g.open, release: g.release };
		this.gates.push(entry);
		// Unwind on failure only. Releasing when the wait *succeeds* — which is what a .finally here does —
		// opens the gate on the microtask that settles `hit`, always before the awaiting test resumes: the
		// caller would be handed an action whose request has already been let go, and the returned release()
		// would have nothing left to release. Holding is the whole point of the surface.
		//
		// The success path needs no cleanup here: `request()` removes the entry from `gates` when it matches.
		// A timed-out or rejected wait does, or the parked request would wait on a gate nobody can reach.
		const hit = this.listenForAction(test, 2000, 'pending').catch(error => {
			this.gates = this.gates.filter(other => other !== entry);
			g.release();
			throw error;
		});
		return { hit, release: g.release };
	}

	private notifyListeners(action: RecordedAction, phase: NotifyPhase): void {
		for (const listener of [...this.listeners]) listener.onAction(action, phase);
	}

	private observerRequest(
		url: `/${string}`,
		requestOptions: ApiRequestOptions,
	): { url: `/${string}`; request: ApiRequestOptions } {
		const request = { ...requestOptions, auth: requestOptions.auth ?? true };
		const { finalUrl } = this.parseRequest({ url, headers: { 'User-Agent': this.options.userAgent }, request });
		return { url: finalUrl as `/${string}`, request };
	}

	private observerResponse(body: unknown, status = 200): Response {
		const payload = this.responseBody(body);
		return new Response(payload, {
			status,
			statusText: STATUS_TEXT[status] ?? (status === 200 ? 'OK' : ''),
			headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
		});
	}

	private responseBody(body: unknown): ConstructorParameters<typeof Response>[0] | undefined {
		if (body === undefined) return undefined;
		if (
			typeof body === 'string' ||
			body instanceof ArrayBuffer ||
			body instanceof Blob ||
			body instanceof FormData ||
			body instanceof URLSearchParams
		) {
			return body;
		}
		try {
			return JSON.stringify(body);
		} catch {
			return undefined;
		}
	}

	private statusCodeFor(error: unknown): number | undefined {
		if (error instanceof MockApiError) return error.status;
		if (isRecord(error)) {
			if (typeof error.status === 'number') return error.status;
			const metadata = error.metadata;
			if (isRecord(metadata) && typeof metadata.status === 'number') return metadata.status;
		}
		return undefined;
	}

	private errorBodyFor(error: unknown): unknown {
		if (error instanceof MockApiError) return { code: error.code, message: error.message };
		if (isRecord(error) && isRecord(error.metadata) && 'response' in error.metadata) return error.metadata.response;
		return { message: error instanceof Error ? error.message : String(error) };
	}

	private hasRestNotification(name: 'onRequest' | 'onSuccess' | 'onFail' | 'onRatelimit'): boolean {
		if (name === 'onSuccess' && this.onSuccessRequest) return true;
		if (name === 'onFail' && this.onFailRequest) return true;
		if (name === 'onRatelimit' && this.onRatelimit) return true;
		return (this.pluginRestObserverProvider?.() ?? []).some(entry => typeof entry.observer[name] === 'function');
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
		const context = dispatchStore.getStore();
		const dispatchId = context?.dispatchId ?? 0;
		const action: RecordedAction = {
			seq: this.seq++,
			dispatchId,
			...(context?.sessionKey === undefined ? {} : { sessionKey: context.sessionKey }),
			...pending,
			settled: false,
			response: undefined,
		};
		this.actions.push(action);
		this.inFlight.add(action);
		this.notifyListeners(action, 'pending');
		const observer = this.observerRequest(url, requestOptions);
		const notifier = this as unknown as ApiObserverNotifier;

		try {
			if (this.hasRestNotification('onRequest')) {
				await notifier.notifyRequest(method, observer.url, observer.request);
			}

			for (const entry of [...this.gates]) {
				if (entry.test(action)) {
					this.gates = this.gates.filter(other => other !== entry);
					await entry.hold();
				}
			}

			try {
				const response = await this.resolveResponse(pending);
				this.assertUsableResponse(response, pending);
				action.response = response;
				action.settled = true;
				if (response !== null && typeof response === 'object' && this.syntheticResponses.has(response)) {
					action.synthetic = true;
				}
				if (this.hasRestNotification('onSuccess')) {
					await notifier.notifySuccessRequest(method, observer.url, this.observerResponse(response), observer.request);
				}
				this.notifyListeners(action, 'settled');
				return response as T;
			} catch (error) {
				action.error = error;
				action.settled = true;
				const statusCode = this.statusCodeFor(error);
				if (statusCode === 429 && this.hasRestNotification('onRatelimit')) {
					await notifier.notifyRatelimit(
						this.observerResponse(this.errorBodyFor(error), statusCode),
						observer.request,
						method,
						observer.url,
					);
				}
				if (this.hasRestNotification('onFail')) {
					await notifier.notifyFailRequest(method, observer.url, error, statusCode, observer.request);
				}
				this.notifyListeners(action, 'settled');
				throw error;
			}
		} finally {
			this.inFlight.delete(action);
		}
	}

	/**
	 * REST requests currently between request() entry and completion (includes gated/parked requests).
	 * A numeric scope selects one dispatch; a predicate can express interaction-token ownership exactly.
	 */
	pendingRequests(scope?: number | ActionPredicate): RecordedAction[] {
		if (scope === undefined) return [...this.inFlight];
		if (typeof scope === 'number') return [...this.inFlight].filter(action => action.dispatchId === scope);
		return [...this.inFlight].filter(scope);
	}

	pendingRequestCount(scope?: number | ActionPredicate): number {
		return this.pendingRequests(scope).length;
	}

	hasPendingRequests(scope?: number | ActionPredicate): boolean {
		return this.pendingRequests(scope).length > 0;
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
			const answer = interceptor.responder(pending, params);
			// A `fail({ when })` whose predicate said no steps aside, so the route's real handler still answers.
			// Anything else would make a conditional failure silently suppress the behaviour it conditions on.
			if (answer === PASS_TO_NEXT) continue;
			return answer;
		}

		// No interceptor handled this request. Surface the gap (respecting onUnhandledRest) before answering with
		// a synthetic, regardless of whether the route is already modeled; otherwise strict mode misses typos and
		// newly introduced non-GET endpoints.
		this.reportUnhandled(pending);
		return this.markSynthetic(this.syntheticResponse(pending));
	}

	/**
	 * Catch a responder that answered with something seyfert cannot treat as a Discord payload, at the seam
	 * where the route and the request are still known.
	 *
	 * Unguarded, a returned string dies several frames away inside seyfert's cache — `TypeError: Cannot read
	 * properties of undefined (reading 'startsWith')` — which names neither the route, nor the responder, nor
	 * this package. `undefined` and `null` stay legal: an empty body is what a 204 looks like. Checked on the
	 * value the caller already awaited, not by wrapping the responder: an extra `.then` would delay `settled`
	 * by a microtask, and the drain guarantees are measured in those.
	 */
	private assertUsableResponse(value: unknown, pending: PendingAction): void {
		if (value === undefined || value === null || typeof value === 'object') return;
		throw new TypeError(
			`intercept(${pending.method} ${pending.route}): the responder returned the ${typeof value} ` +
				`${JSON.stringify(value)}, which is not a Discord payload. Return the object the route answers with ` +
				'(or undefined for an empty body); to make the call fail, throw — rest.fail(matcher, { status, code }) ' +
				'builds the error Discord would send.',
		);
	}

	private syntheticResponse(pending: PendingAction): unknown {
		if (pending.method === 'GET') {
			const entry = SYNTHETIC_GET_SHAPES.find(row => row.pattern.test(pending.route));
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
