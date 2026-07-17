import type { ApiRequestOptions, HttpMethods } from 'seyfert';
import { isRecord } from './internal';

const PROXY_ERROR_CODES = [
	'PROXY_UNAUTHENTICATED',
	'PROXY_TOKEN_OVERRIDE_UNSUPPORTED',
	'PROXY_PAYLOAD_TOO_LARGE',
	'PROXY_OVERLOADED',
	'PROXY_QUEUE_TIMEOUT',
	'PROXY_DRAINING',
	'PROXY_QUARANTINED',
	'PROXY_INTERNAL',
] as const;

export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number];
export type ProxyOutcome = 'not_dispatched' | 'completed' | 'unknown';

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
	requestId: string;
	fileKeys?: (string | null)[];
}

const methods = new Set<HttpMethods>(['GET', 'DELETE', 'PUT', 'POST', 'PATCH']);
const codes = new Set<string>(PROXY_ERROR_CODES);
const outcomes = new Set<ProxyOutcome>(['not_dispatched', 'completed', 'unknown']);
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
	if (
		value.fileKeys !== undefined &&
		(!Array.isArray(value.fileKeys) || value.fileKeys.some(key => key !== null && typeof key !== 'string'))
	) {
		return;
	}
	if (value.token !== undefined) return;

	return {
		method: value.method as HttpMethods,
		url: value.url as `/${string}`,
		requestId: value.requestId,
		...(value.query === undefined ? {} : { query: value.query }),
		...(value.body === undefined ? {} : { body: value.body }),
		...(value.auth === undefined ? {} : { auth: value.auth }),
		...(value.reason === undefined ? {} : { reason: value.reason }),
		...(value.appendToFormData === undefined ? {} : { appendToFormData: value.appendToFormData }),
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
		outcomes.has(value.outcome as ProxyOutcome) &&
		typeof value.message === 'string' &&
		typeof value.requestId === 'string'
	);
}

export function parseResponseEnvelope(value: unknown): ProxyResponseEnvelope | undefined {
	if (!isRecord(value) || typeof value.kind !== 'string') return;
	if (isProxyErrorEnvelope(value)) return value;
	if (value.kind === 'success' && typeof value.status === 'number') {
		return value as unknown as SuccessEnvelope;
	}
	if (
		value.kind === 'discord_error' &&
		typeof value.status === 'number' &&
		isRecord(value.error) &&
		typeof value.error.code === 'string' &&
		(value.error.metadata === undefined || isRecord(value.error.metadata))
	) {
		return value as unknown as DiscordErrorEnvelope;
	}
	return;
}

export class ProxyError extends Error {
	readonly code: ProxyErrorCode;
	readonly outcome: ProxyOutcome;
	readonly requestId: string;

	constructor(payload: Omit<ProxyErrorEnvelope, 'kind'>, options?: ErrorOptions) {
		super(payload.message, options);
		this.name = 'ProxyError';
		this.code = payload.code;
		this.outcome = payload.outcome;
		this.requestId = payload.requestId;
	}
}

export function proxyError(
	code: ProxyErrorCode,
	outcome: ProxyOutcome,
	requestId: string,
	message: string,
): ProxyErrorEnvelope {
	return { kind: 'proxy_error', code, outcome, message, requestId };
}
