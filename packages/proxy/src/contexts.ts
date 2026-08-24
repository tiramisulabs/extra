import { createHash } from 'node:crypto';
import { ApiHandler, type ApiRequestOptions } from 'seyfert';
import { SlidingWindow } from './gates';
import { proxyApiHandlerMarker } from './internal';

const UNAUTHENTICATED_CONTEXT = 'unauthenticated';

export interface GateOptions {
	max: number;
	perMs: number;
}

export type CreateRestForToken = (token: string) => ApiHandler | Promise<ApiHandler>;

export interface RestContext {
	readonly key: string;
	readonly rest: ApiHandler;
	readonly gate: SlidingWindow;
	override: boolean;
	readonly token?: string;
	activeRequests: number;
	lastUsedAt: number;
}

export class TokenContextUnavailableError extends Error {}

export function isCompatibleApiHandler(value: unknown): value is ApiHandler {
	if (typeof value !== 'object' || value === null) return false;
	if (proxyApiHandlerMarker in value) return false;
	if (!('request' in value) || typeof value.request !== 'function') return false;
	if (!('observe' in value) || typeof value.observe !== 'function') return false;
	if (!('options' in value) || typeof value.options !== 'object' || value.options === null) return false;
	if (!('token' in value.options) || typeof value.options.token !== 'string') return false;
	if ('workerProxy' in value.options && value.options.workerProxy === true) return false;
	return 'ratelimits' in value && value.ratelimits instanceof Map;
}

export function tokenFingerprint(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

export class RestContextManager {
	private readonly contexts = new Map<string, RestContext>();
	private readonly creating = new Map<string, Promise<RestContext>>();
	private readonly quarantined = new Set<string>();
	private readonly initializedHandlers = new WeakSet<ApiHandler>();
	private readonly handlerOwners = new WeakMap<ApiHandler, string>();
	private readonly unauthenticated: RestContext;
	private currentDefaultKey: string;

	constructor(
		private readonly defaultRest: ApiHandler,
		private readonly createRestForToken: CreateRestForToken | undefined,
		private readonly maxTokenContexts: number,
		private readonly authenticatedGate: GateOptions,
		unauthenticatedGate: GateOptions,
		private readonly initializeHandler: (rest: ApiHandler) => void,
	) {
		this.unauthenticated = {
			key: UNAUTHENTICATED_CONTEXT,
			rest: defaultRest,
			gate: new SlidingWindow(unauthenticatedGate.max, unauthenticatedGate.perMs),
			override: false,
			activeRequests: 0,
			lastUsedAt: Date.now(),
		};
		this.initialize(defaultRest);
		const initialToken = defaultRest.options.token;
		this.currentDefaultKey = tokenFingerprint(initialToken);
		this.handlerOwners.set(defaultRest, this.currentDefaultKey);
		this.contexts.set(
			this.currentDefaultKey,
			this.createContext(this.currentDefaultKey, defaultRest, false, initialToken),
		);
	}

	private initialize(rest: ApiHandler): void {
		if (this.initializedHandlers.has(rest)) return;
		this.initializedHandlers.add(rest);
		try {
			this.initializeHandler(rest);
		} catch (error) {
			this.initializedHandlers.delete(rest);
			throw error;
		}
	}

	// Deduplication runs before a handler exists, so an omitted token means the live default token.
	identity(auth: boolean | undefined, token: string | undefined): string {
		if (auth === false) return UNAUTHENTICATED_CONTEXT;
		return tokenFingerprint(token ?? this.defaultRest.options.token);
	}

	async resolve(auth: boolean | undefined, token: string | undefined): Promise<RestContext> {
		if (auth === false) {
			this.unauthenticated.lastUsedAt = Date.now();
			return this.unauthenticated;
		}

		const activeDefaultToken = this.defaultRest.options.token;
		const selectedToken = token ?? activeDefaultToken;
		const key = tokenFingerprint(selectedToken);
		const existing = this.contexts.get(key);
		if (existing) {
			if (selectedToken === activeDefaultToken && key !== this.currentDefaultKey) this.promoteDefault(existing);
			existing.lastUsedAt = Date.now();
			return existing;
		}

		if (!this.createRestForToken) {
			throw new TokenContextUnavailableError(
				selectedToken === activeDefaultToken
					? 'Default token rotation requires createRestForToken to preserve isolated rate-limit state.'
					: 'This proxy deployment does not configure createRestForToken for token overrides.',
			);
		}

		const pending = this.creating.get(key);
		if (pending) return pending;
		const creation =
			selectedToken === activeDefaultToken
				? this.createRotatedDefaultContext(key, selectedToken)
				: this.createOverrideContext(key, selectedToken);
		this.creating.set(key, creation);
		try {
			return await creation;
		} finally {
			this.creating.delete(key);
		}
	}

	private promoteDefault(context: RestContext): void {
		const previous = this.contexts.get(this.currentDefaultKey);
		if (previous) previous.override = true;
		context.override = false;
		this.currentDefaultKey = context.key;
	}

	private async createRotatedDefaultContext(key: string, token: string): Promise<RestContext> {
		this.assertContextCapacity();
		const rest = await this.createDistinctHandler(key, token);
		const stillDefault = this.defaultRest.options.token === token;
		const context = this.createContext(key, rest, !stillDefault, token);
		if (stillDefault) this.promoteDefault(context);
		this.contexts.set(key, context);
		return context;
	}

	private async createOverrideContext(key: string, token: string): Promise<RestContext> {
		this.assertContextCapacity();
		const rest = await this.createDistinctHandler(key, token);
		const context = this.createContext(key, rest, true, token);
		this.contexts.set(key, context);
		return context;
	}

	private assertContextCapacity(): void {
		this.evictOverrideContext();
		const overrideCount = [...this.contexts.values()].filter(context => context.override).length;
		if (overrideCount + this.creating.size >= this.maxTokenContexts) {
			throw new TokenContextUnavailableError('All configured token contexts are currently active.');
		}
	}

	private async createDistinctHandler(key: string, token: string): Promise<ApiHandler> {
		const rest = await this.createRestForToken!(token);
		if (!isCompatibleApiHandler(rest)) {
			throw new TokenContextUnavailableError(
				'createRestForToken must return a compatible direct Discord ApiHandler with workerProxy disabled.',
			);
		}
		if (rest === this.defaultRest || this.handlerOwners.has(rest)) {
			throw new TokenContextUnavailableError('createRestForToken must return a distinct ApiHandler for each token.');
		}
		this.handlerOwners.set(rest, key);
		try {
			this.initialize(rest);
		} catch (error) {
			this.handlerOwners.delete(rest);
			throw error;
		}
		return rest;
	}

	private createContext(key: string, rest: ApiHandler, override: boolean, token: string): RestContext {
		return {
			key,
			rest,
			gate: new SlidingWindow(this.authenticatedGate.max, this.authenticatedGate.perMs),
			override,
			token,
			activeRequests: 0,
			lastUsedAt: Date.now(),
		};
	}

	private evictOverrideContext(): void {
		const overrideContexts = [...this.contexts.values()].filter(context => context.override);
		if (overrideContexts.length < this.maxTokenContexts) return;
		const now = Date.now();
		const candidate = overrideContexts
			.filter(
				context =>
					context.activeRequests === 0 &&
					!this.quarantined.has(context.key) &&
					![...context.rest.ratelimits.values()].some(bucket => bucket.remaining <= 0 && bucket.reset > now),
			)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
		if (candidate) {
			this.contexts.delete(candidate.key);
		}
	}

	retain(context: RestContext): void {
		context.activeRequests++;
		context.lastUsedAt = Date.now();
	}

	release(context: RestContext): void {
		context.activeRequests = Math.max(0, context.activeRequests - 1);
		context.lastUsedAt = Date.now();
	}

	quarantine(key: string): void {
		if (key !== UNAUTHENTICATED_CONTEXT) this.quarantined.add(key);
	}

	isQuarantined(key: string): boolean {
		return this.quarantined.has(key);
	}

	get defaultContextIssue(): 'PROXY_TOKEN_CONTEXT_UNAVAILABLE' | 'PROXY_TOKEN_REJECTED' | undefined {
		const key = tokenFingerprint(this.defaultRest.options.token);
		if (this.quarantined.has(key)) return 'PROXY_TOKEN_REJECTED';
		if (!this.contexts.has(key) && !this.createRestForToken) return 'PROXY_TOKEN_CONTEXT_UNAVAILABLE';
		return;
	}

	// Observer callbacks belong to the handler that dispatched, whose token is the authoritative fallback.
	requestIdentity(rest: ApiHandler, request: Readonly<ApiRequestOptions>): string {
		if (request.auth === false) return UNAUTHENTICATED_CONTEXT;
		return tokenFingerprint(request.token ?? rest.options.token);
	}

	blockGlobal(key: string, delay: number): void {
		if (key === UNAUTHENTICATED_CONTEXT) this.unauthenticated.gate.blockFor(delay);
		else this.contexts.get(key)?.gate.blockFor(delay);
	}

	get tokenContextCount(): number {
		return this.contexts.size;
	}

	authenticatedGateOccupancy(now: number): number {
		let occupancy = 0;
		for (const context of this.contexts.values()) occupancy += context.gate.occupancy(now);
		return occupancy;
	}

	unauthenticatedGateOccupancy(now: number): number {
		return this.unauthenticated.gate.occupancy(now);
	}
}
