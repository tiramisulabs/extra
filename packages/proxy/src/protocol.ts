import type { ApiRequestOptions, HttpMethods } from 'seyfert';
import { isRecord } from './internal';

const PROXY_ERROR_CODES = [
	'PROXY_UNAUTHENTICATED',
	'PROXY_AUTHENTICATION_UNAVAILABLE',
	'PROXY_BAD_REQUEST',
	'PROXY_NOT_FOUND',
	'PROXY_TOKEN_CONTEXT_UNAVAILABLE',
	'PROXY_TOKEN_REJECTED',
	'PROXY_REQUEST_ID_CONFLICT',
	'PROXY_INVALID_REQUEST_BUDGET_EXHAUSTED',
	'PROXY_PAYLOAD_TOO_LARGE',
	'PROXY_OVERLOADED',
	'PROXY_QUEUE_TIMEOUT',
	'PROXY_DRAINING',
	'PROXY_UNSUPPORTED_SEYFERT',
	'PROXY_INTERNAL',
] as const;

const PROXY_OUTCOMES = ['not_dispatched', 'completed', 'unknown'] as const;
const PROXY_PHASES = [
	'transport',
	'routing',
	'authentication',
	'admission',
	'decoding',
	'deduplication',
	'dispatch',
	'drain',
	'startup',
	'internal',
] as const;

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number];
export type ProxyOutcome = (typeof PROXY_OUTCOMES)[number];
export type ProxyPhase = (typeof PROXY_PHASES)[number];

export interface SuccessEnvelope {
	kind: 'success';
	status: number;
	body?: unknown;
}

export interface SerializedSeyfertError {
	code: string;
	metadata?: Record<string, unknown>;
}

export interface DiscordErrorEnvelope {
	kind: 'discord_error';
	status: number;
	body?: unknown;
	error: SerializedSeyfertError;
}

export interface ProxyErrorEnvelope {
	kind: 'proxy_error';
	code: ProxyErrorCode;
	outcome: ProxyOutcome;
	message: string;
	requestId: string;
	phase: ProxyPhase;
	instanceId?: string;
}

export type ProxyResponseEnvelope = SuccessEnvelope | DiscordErrorEnvelope | ProxyErrorEnvelope;

export interface WireApiRequest {
	method: HttpMethods;
	url: `/${string}`;
	query?: Record<string, unknown>;
	body?: Record<string, unknown> | unknown[];
	auth?: boolean;
	reason?: string;
	appendToFormData?: boolean;
	token?: string;
	requestId: string;
	fileKeys?: (string | null)[];
}

const methods = new Set<HttpMethods>(['GET', 'DELETE', 'PUT', 'POST', 'PATCH']);
const codes = new Set<string>(PROXY_ERROR_CODES);
const outcomes = new Set<string>(PROXY_OUTCOMES);
const phases = new Set<string>(PROXY_PHASES);
// Request IDs intentionally own this rule; they may evolve independently from service IDs.
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function isRequestId(value: unknown): value is string {
	return typeof value === 'string' && requestIdPattern.test(value);
}

export function parseWireRequest(value: unknown): WireApiRequest | undefined {
	if (!isRecord(value)) return;
	if (!methods.has(value.method as HttpMethods)) return;
	if (typeof value.url !== 'string' || !value.url.startsWith('/')) return;
	if (!isRequestId(value.requestId)) return;
	if (value.query !== undefined && !isRecord(value.query)) return;
	if (value.body !== undefined && !isRecord(value.body) && !Array.isArray(value.body)) return;
	if (value.auth !== undefined && typeof value.auth !== 'boolean') return;
	if (value.reason !== undefined && typeof value.reason !== 'string') return;
	if (value.appendToFormData !== undefined && typeof value.appendToFormData !== 'boolean') return;
	if (value.token !== undefined && (typeof value.token !== 'string' || value.token.length === 0)) return;
	if (
		value.fileKeys !== undefined &&
		(!Array.isArray(value.fileKeys) || value.fileKeys.some(key => key !== null && typeof key !== 'string'))
	) {
		return;
	}
	return {
		method: value.method as HttpMethods,
		url: value.url as `/${string}`,
		requestId: value.requestId,
		...(value.query === undefined ? {} : { query: value.query }),
		...(value.body === undefined ? {} : { body: value.body }),
		...(value.auth === undefined ? {} : { auth: value.auth }),
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.appendToFormData === undefined ? {} : { appendToFormData: value.appendToFormData }),
		...(value.token === undefined ? {} : { token: value.token }),
		...(value.fileKeys === undefined ? {} : { fileKeys: value.fileKeys as (string | null)[] }),
	};
}

export function toApiRequestOptions(request: WireApiRequest, files?: ApiRequestOptions['files']): ApiRequestOptions {
	return {
		query: request.query,
		body: request.body as ApiRequestOptions['body'],
		files,
		auth: request.auth,
		reason: request.reason,
		appendToFormData: request.appendToFormData,
	};
}

function isProxyErrorEnvelope(value: unknown): value is ProxyErrorEnvelope {
	return (
		isRecord(value) &&
		value.kind === 'proxy_error' &&
		typeof value.code === 'string' &&
		codes.has(value.code) &&
		typeof value.outcome === 'string' &&
		outcomes.has(value.outcome) &&
		typeof value.message === 'string' &&
		typeof value.requestId === 'string' &&
		typeof value.phase === 'string' &&
		phases.has(value.phase) &&
		(value.instanceId === undefined || typeof value.instanceId === 'string')
	);
}

export function parseResponseEnvelope(value: unknown): ProxyResponseEnvelope | undefined {
	if (!isRecord(value) || typeof value.kind !== 'string') return;
	if (isProxyErrorEnvelope(value)) {
		return {
			kind: 'proxy_error',
			code: value.code,
			outcome: value.outcome,
			message: value.message,
			requestId: value.requestId,
			phase: value.phase,
			...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
		};
	}
	if (value.kind === 'success' && typeof value.status === 'number') {
		return {
			kind: 'success',
			status: value.status,
			...(value.body === undefined ? {} : { body: value.body }),
		};
	}
	if (
		value.kind === 'discord_error' &&
		typeof value.status === 'number' &&
		isRecord(value.error) &&
		typeof value.error.code === 'string' &&
		(value.error.metadata === undefined || isRecord(value.error.metadata))
	) {
		return {
			kind: 'discord_error',
			status: value.status,
			...(value.body === undefined ? {} : { body: value.body }),
			error: {
				code: value.error.code,
				...(value.error.metadata === undefined ? {} : { metadata: value.error.metadata }),
			},
		};
	}
	return;
}

export class ProxyError extends Error {
	readonly code: ProxyErrorCode;
	readonly outcome: ProxyOutcome;
	readonly requestId: string;
	readonly phase: ProxyPhase;
	readonly instanceId?: string;

	constructor(payload: Omit<ProxyErrorEnvelope, 'kind'>, options?: ErrorOptions) {
		super(payload.message, options);
		this.name = 'ProxyError';
		this.code = payload.code;
		this.outcome = payload.outcome;
		this.requestId = payload.requestId;
		this.phase = payload.phase;
		this.instanceId = payload.instanceId;
	}
}

export function proxyError(
	code: ProxyErrorCode,
	outcome: ProxyOutcome,
	requestId: string,
	message: string,
	phase: ProxyPhase,
	instanceId?: string,
): ProxyErrorEnvelope {
	return {
		kind: 'proxy_error',
		code,
		outcome,
		message,
		requestId,
		phase,
		...(instanceId === undefined ? {} : { instanceId }),
	};
}
