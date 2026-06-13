import { ApiHandler } from 'seyfert';
import type { ApiRequestOptions, HttpMethods } from 'seyfert/lib/api/shared';
import { apiMessage } from './payloads';

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

interface Interceptor {
	method: HttpMethods;
	pattern: RegExp;
	names: string[];
	responder: RouteResponder;
}

interface ActionListener {
	onAction(action: RecordedAction): void;
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

export class MockApiHandler extends ApiHandler {
	readonly actions: RecordedAction[] = [];
	private listeners: ActionListener[] = [];
	private interceptors: Interceptor[] = [];
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

	intercept(matcher: RouteMatcher, responder: RouteResponder): this;
	intercept(method: HttpMethods, route: string | RegExp, responder: RouteResponder): this;
	intercept(
		methodOrMatcher: HttpMethods | RouteMatcher,
		routeOrResponder: string | RegExp | RouteResponder,
		maybeResponder?: RouteResponder,
	): this {
		if (typeof methodOrMatcher === 'object') {
			return this.intercept(methodOrMatcher.method, methodOrMatcher.route, routeOrResponder as RouteResponder);
		}

		const responder = maybeResponder;
		if (!responder || typeof routeOrResponder === 'function') {
			throw new TypeError('MockApiHandler.intercept requires a route and responder');
		}
		const compiled =
			typeof routeOrResponder === 'string' ? compileRoute(routeOrResponder) : { pattern: routeOrResponder, names: [] };
		this.interceptors.unshift({ method: methodOrMatcher, ...compiled, responder });
		return this;
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

	calls(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction[] {
		const out: MatchedAction[] = [];
		for (const action of this.actions) {
			if (typeof matcher === 'function') {
				if (matcher(action)) out.push({ ...action, params: {} });
				continue;
			}

			const captured = this.matchParams(matcher, action);
			if (!captured) continue;
			if (params && Object.entries(params).some(([key, value]) => captured[key] !== value)) continue;
			out.push({ ...action, params: captured });
		}
		return out;
	}

	call(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction | undefined {
		return this.calls(matcher, params)[0];
	}

	waitForAction(matcher: RouteMatcher, timeoutMs?: number): Promise<MatchedAction>;
	waitForAction(predicate: (action: RecordedAction) => boolean, timeoutMs?: number): Promise<MatchedAction>;
	waitForAction(
		matcherOrPredicate: RouteMatcher | ((action: RecordedAction) => boolean),
		timeoutMs = 2000,
	): Promise<MatchedAction> {
		const enrich = (action: RecordedAction): MatchedAction => {
			if (typeof matcherOrPredicate === 'function') return { ...action, params: {} };
			return { ...action, params: this.matchParams(matcherOrPredicate, action) ?? {} };
		};
		const predicate =
			typeof matcherOrPredicate === 'function'
				? matcherOrPredicate
				: (action: RecordedAction) => this.matches(matcherOrPredicate, action);

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
				onAction: (action: RecordedAction) => {
					if (!predicate(action)) return;
					clearTimeout(listener.timer);
					this.listeners = this.listeners.filter(entry => entry !== listener);
					resolve(enrich(action));
				},
			};
			this.listeners.push(listener);
		});
	}

	gateNext(matcher?: RouteMatcher | ((action: RecordedAction) => boolean)): {
		hit: Promise<RecordedAction>;
		release: () => void;
	} {
		const g = gate();
		const startSeq = this.seq;
		const test = (action: RecordedAction) =>
			action.seq >= startSeq &&
			(!matcher || (typeof matcher === 'function' ? matcher(action) : this.matches(matcher, action)));
		const entry = { test, hold: () => g.open, release: g.release };
		this.gates.push(entry);
		const hit = this.waitForAction(test).finally(() => {
			this.gates = this.gates.filter(other => other !== entry);
			g.release();
		});
		return { hit, release: g.release };
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
		for (const listener of [...this.listeners]) listener.onAction(action);

		for (const entry of [...this.gates]) {
			if (entry.test(action)) {
				this.gates = this.gates.filter(other => other !== entry);
				await entry.hold();
			}
		}

		const response = await this.resolveResponse(pending);
		action.response = response;
		return response as T;
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
