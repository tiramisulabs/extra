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

/** Named Discord JSON error codes used by the mock's fail-loud guards, so no call site spells a bare number. */
export const ErrorCode = {
	UnknownChannel: 10003,
	UnknownGuild: 10004,
	UnknownUser: 10013,
	UnknownMember: 10007,
	UnknownMessage: 10008,
	UnknownWebhook: 10015,
	UnknownBan: 10026,
	UnknownInvite: 10006,
	UnknownGuildTemplate: 10057,
	UnknownRole: 10011,
	UnknownEmoji: 10014,
	UnknownSticker: 10060,
	UnknownStageInstance: 10067,
	UnknownScheduledEvent: 180000,
	MaxPinnedMessages: 30003,
	CannotEditAnotherUsersMessage: 50005,
	CannotSendEmptyMessage: 50006,
	MissingPermissions: 50013,
	CannotExecuteOnChannelType: 50024,
	InvalidFormBody: 50035,
	ThreadArchived: 50083,
	AlreadyAcknowledged: 40060,
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
} as const satisfies Record<string, DiscordErrorInit>;

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

export interface RouteMatcher<TRoute extends string = string> {
	method: HttpMethods;
	route: TRoute;
}

/** A read-only REST snapshot, enriched with params captured from the supplied route descriptor. */
export type RestCall<TParams extends Record<string, string | undefined> = Record<string, undefined>> = Readonly<
	RecordedAction & { params: TParams }
>;

/** Read the latest stateful step's REST calls, optionally narrowed by one route descriptor. */
export interface RestCalls {
	(): readonly RestCall[];
	<TRoute extends string>(matcher: RouteMatcher<TRoute>): readonly RestCall<RouteParams<TRoute>>[];
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
	private readonly routeCache = new Map<string, { pattern: RegExp; names: string[] }>();
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

	matchRouteParams<TRoute extends string>(
		matcher: RouteMatcher<TRoute>,
		action: Pick<RecordedAction, 'method' | 'route'>,
	): RouteParams<TRoute> | undefined {
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
		return params as RouteParams<TRoute>;
	}

	matches(matcher: RouteMatcher, action: Pick<RecordedAction, 'method' | 'route'>): boolean {
		return this.matchRouteParams(matcher, action) !== undefined;
	}

	/** @internal Temporal coordination for dispatch machinery; user assertions belong to bot.restCalls(). */
	waitUntilAction(matcherOrPredicate: RouteMatcher | ActionPredicate, timeoutMs = 2000): Promise<RecordedAction> {
		return this.listenForAction(matcherOrPredicate, timeoutMs, 'settled');
	}

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
		const hit = this.listenForAction(test, 2000, 'pending').finally(() => {
			this.gates = this.gates.filter(other => other !== entry);
			g.release();
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
			return interceptor.responder(pending, params);
		}

		// No interceptor handled this request. Surface the gap (respecting onUnhandledRest) before answering with
		// a synthetic, regardless of whether the route is already modeled; otherwise strict mode misses typos and
		// newly introduced non-GET endpoints.
		this.reportUnhandled(pending);
		return this.markSynthetic(this.syntheticResponse(pending));
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
