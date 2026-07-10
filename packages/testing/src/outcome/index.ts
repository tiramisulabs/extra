import { InteractionResponseType } from 'seyfert';
import type { CapturedReply, DispatchResult, OutgoingMessage } from '../bot/bot';
import type { DispatchDenial } from '../bot/dispatch-context';
import { isEphemeral } from '../bot/message-flags';

export function outcome(result: DispatchResult): OutcomeReader {
	const scope = createScope(result);
	return {
		raw: {
			result: () => result,
		},
		get: makeFinder('get', scope),
		query: makeFinder('query', scope),
		all: makeFinder('all', scope),
		debug: () => debugOutcome(scope),
	};
}

export type OutcomeReaderMode = 'get' | 'query' | 'all';

export interface OutcomeReader {
	readonly raw: OutcomeRaw;
	readonly get: OutcomeFinder<'get'>;
	readonly query: OutcomeFinder<'query'>;
	readonly all: OutcomeFinder<'all'>;
	debug(): string;
}

export interface OutcomeRaw {
	result(): DispatchResult;
}

export interface OutcomeFinder<Mode extends OutcomeReaderMode> {
	response(query?: ResponseQuery): OutcomeResult<Mode, OutcomeResponse>;
	denial(query?: DenialQuery): OutcomeResult<Mode, OutcomeDenial>;
	error(query?: ErrorQuery): OutcomeResult<Mode, OutcomeCapturedError>;
	error(matcher: string | RegExp): OutcomeResult<Mode, OutcomeCapturedError>;
	error(matcher: (error: unknown) => boolean): OutcomeResult<Mode, OutcomeCapturedError>;
}

export type OutcomeResult<Mode extends OutcomeReaderMode, View> = Mode extends 'get'
	? View
	: Mode extends 'query'
		? View | undefined
		: readonly View[];

export type ResponseKind =
	| 'reply'
	| 'defer'
	| 'deferReply'
	| 'deferUpdate'
	| 'update'
	| 'modal'
	| 'autocomplete'
	| 'edit'
	| 'followup';

export interface ResponseQuery {
	kind?: ResponseKind;
	ephemeral?: boolean;
}

export interface OutcomeResponse {
	readonly kind: 'response';
	readonly deferred: boolean;
	readonly deferredReply: boolean;
	readonly deferredUpdate: boolean;
	readonly ephemeral: boolean;
	readonly modal?: { customId?: string; title?: string };
	readonly events: readonly OutcomeResponseEvent[];
	readonly raw: {
		readonly replies: readonly CapturedReply[];
		readonly edits: readonly OutgoingMessage[];
		readonly followups: readonly OutgoingMessage[];
	};
}

export interface OutcomeResponseEvent {
	readonly kind: 'reply' | 'deferReply' | 'deferUpdate' | 'update' | 'modal' | 'autocomplete' | 'edit' | 'followup';
	readonly path: string;
	readonly ephemeral?: boolean;
	readonly raw: unknown;
}

export interface DenialQuery {
	kind?: DispatchDenial['kind'];
	middleware?: string;
	missing?: string | readonly string[];
}

export interface OutcomeDenial {
	readonly kind: 'denial';
	readonly denialKind: DispatchDenial['kind'];
	readonly reason?: unknown;
	readonly middleware?: string;
	readonly missing: readonly string[];
	readonly raw: DispatchDenial;
}

export type ErrorMatcher = string | RegExp | ((error: unknown) => boolean);

export interface ErrorQuery {
	match?: ErrorMatcher;
}

export interface OutcomeCapturedError {
	readonly kind: 'error';
	readonly error: unknown;
}

type OutcomeKind = 'response' | 'denial' | 'error';

interface OutcomeScope {
	readonly result: DispatchResult;
	readonly response?: OutcomeResponse;
	readonly denial?: OutcomeDenial;
	readonly error?: OutcomeCapturedError;
}

interface Candidate<View> {
	readonly value: View;
	readonly summary: string;
}

export class OutcomeError extends Error {
	constructor(
		message: string,
		readonly details: {
			readonly mode: OutcomeReaderMode;
			readonly kind: OutcomeKind;
			readonly query: unknown;
			readonly matches: readonly string[];
			readonly candidates: readonly string[];
			readonly reason?: string;
		},
	) {
		super(message);
		this.name = 'OutcomeError';
	}
}

const RESPONSE_QUERY_KEYS = ['kind', 'ephemeral'] as const satisfies readonly (keyof ResponseQuery)[];
const DENIAL_QUERY_KEYS = ['kind', 'middleware', 'missing'] as const satisfies readonly (keyof DenialQuery)[];
const ERROR_QUERY_KEYS = ['match'] as const satisfies readonly (keyof ErrorQuery)[];

const RESPONSE_KINDS = [
	'reply',
	'defer',
	'deferReply',
	'deferUpdate',
	'update',
	'modal',
	'autocomplete',
	'edit',
	'followup',
] as const satisfies readonly ResponseKind[];

const DENIAL_KINDS = [
	'stop',
	'no-next',
	'permissions',
	'bot-permissions',
] as const satisfies readonly DispatchDenial['kind'][];

function createScope(result: DispatchResult): OutcomeScope {
	return {
		result,
		...(createResponse(result) ?? {}),
		...(createDenial(result) ?? {}),
		...(result.error === undefined ? {} : { error: { kind: 'error', error: result.error } }),
	};
}

function createResponse(result: DispatchResult): Pick<OutcomeScope, 'response'> | undefined {
	const events = [
		...result.replies.map(replyEvent).filter((event): event is OutcomeResponseEvent => event !== undefined),
		...result.edits.map((message, index): OutcomeResponseEvent => messageEvent('edit', message, index)),
		...result.followups.map((message, index): OutcomeResponseEvent => messageEvent('followup', message, index)),
	];
	if (events.length === 0) return undefined;
	return {
		response: {
			kind: 'response',
			deferred: result.deferred,
			deferredReply: result.deferredReply,
			deferredUpdate: result.deferredUpdate,
			ephemeral: result.ephemeral,
			...(result.modal === undefined ? {} : { modal: result.modal }),
			events,
			raw: {
				replies: [...result.replies],
				edits: [...result.edits],
				followups: [...result.followups],
			},
		},
	};
}

function createDenial(result: DispatchResult): Pick<OutcomeScope, 'denial'> | undefined {
	if (!result.denied || !result.denial) return undefined;
	const raw = result.denial;
	return {
		denial: {
			kind: 'denial',
			denialKind: raw.kind,
			...(raw.reason === undefined ? {} : { reason: raw.reason }),
			...(raw.middleware === undefined ? {} : { middleware: raw.middleware }),
			missing: raw.missing ?? [],
			raw,
		},
	};
}

function replyEvent(reply: CapturedReply, index: number): OutcomeResponseEvent | undefined {
	const path = `reply[${index}]`;
	const event = (kind: OutcomeResponseEvent['kind']): OutcomeResponseEvent => ({
		kind,
		path,
		ephemeral: isEphemeral({ flags: flagsOf(dataOf(reply.body)) }),
		raw: reply,
	});
	switch (reply.body.type) {
		case InteractionResponseType.ChannelMessageWithSource:
			return event('reply');
		case InteractionResponseType.DeferredChannelMessageWithSource:
			return event('deferReply');
		case InteractionResponseType.DeferredMessageUpdate:
			return event('deferUpdate');
		case InteractionResponseType.UpdateMessage:
			return event('update');
		case InteractionResponseType.Modal:
			return event('modal');
		case InteractionResponseType.ApplicationCommandAutocompleteResult:
			return event('autocomplete');
		default:
			return undefined;
	}
}

function messageEvent(kind: 'edit' | 'followup', message: OutgoingMessage, index: number): OutcomeResponseEvent {
	return {
		kind,
		path: `${kind}[${index}]`,
		...(message.flags === undefined ? {} : { ephemeral: isEphemeral(message) }),
		raw: message,
	};
}

function dataOf(body: CapturedReply['body']): unknown {
	return 'data' in body ? body.data : undefined;
}

function flagsOf(value: unknown): number | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const flags = (value as { flags?: unknown }).flags;
	return typeof flags === 'number' ? flags : undefined;
}

function makeFinder<Mode extends OutcomeReaderMode>(mode: Mode, scope: OutcomeScope): OutcomeFinder<Mode> {
	return {
		response: query => resolve(mode, 'response', query, responseCandidates(scope, mode, query), scope),
		denial: query => resolve(mode, 'denial', query, denialCandidates(scope, mode, query), scope),
		error: query => resolve(mode, 'error', query, errorCandidates(scope, mode, query), scope),
	} as OutcomeFinder<Mode>;
}

function resolve<Mode extends OutcomeReaderMode, View>(
	mode: Mode,
	kind: OutcomeKind,
	query: unknown,
	candidates: readonly Candidate<View>[],
	scope: OutcomeScope,
): OutcomeResult<Mode, View> {
	if (mode === 'query') return (candidates[0]?.value ?? undefined) as OutcomeResult<Mode, View>;
	if (mode === 'all') return candidates.map(candidate => candidate.value) as OutcomeResult<Mode, View>;
	if (candidates.length === 1) return candidates[0].value as OutcomeResult<Mode, View>;
	throw missingOutcomeError(kind, query, candidates, scope);
}

function responseCandidates(
	scope: OutcomeScope,
	mode: OutcomeReaderMode,
	query: ResponseQuery | undefined,
): Candidate<OutcomeResponse>[] {
	const normalized = normalizeResponseQuery(mode, query);
	const response = scope.response;
	if (!response || !responseMatches(response, normalized)) return [];
	return [{ value: response, summary: summarizeResponse(response) }];
}

function denialCandidates(
	scope: OutcomeScope,
	mode: OutcomeReaderMode,
	query: DenialQuery | undefined,
): Candidate<OutcomeDenial>[] {
	const normalized = normalizeDenialQuery(mode, query);
	const denial = scope.denial;
	if (!denial || !denialMatches(denial, normalized)) return [];
	return [{ value: denial, summary: summarizeDenial(denial) }];
}

function errorCandidates(
	scope: OutcomeScope,
	mode: OutcomeReaderMode,
	query: ErrorQuery | ErrorMatcher | undefined,
): Candidate<OutcomeCapturedError>[] {
	const normalized = normalizeErrorQuery(mode, query);
	const captured = scope.error;
	if (!captured) return [];
	if (normalized?.match !== undefined && !matchesError(captured.error, normalized.match)) return [];
	return [{ value: captured, summary: summarizeError(captured) }];
}

function responseMatches(response: OutcomeResponse, query: ResponseQuery | undefined): boolean {
	if (query?.ephemeral !== undefined && response.ephemeral !== query.ephemeral) return false;
	if (query?.kind === undefined) return true;
	return response.events.some(event => eventMatchesResponseKind(event, query.kind as ResponseKind));
}

function eventMatchesResponseKind(event: OutcomeResponseEvent, kind: ResponseKind): boolean {
	if (kind === 'defer') return event.kind === 'deferReply' || event.kind === 'deferUpdate';
	return event.kind === kind;
}

function denialMatches(denial: OutcomeDenial, query: DenialQuery | undefined): boolean {
	if (query?.kind !== undefined && denial.denialKind !== query.kind) return false;
	if (query?.middleware !== undefined && denial.middleware !== query.middleware) return false;
	if (query?.missing !== undefined) {
		const missing = Array.isArray(query.missing) ? query.missing : [query.missing];
		if (!missing.every(permission => denial.missing.includes(permission))) return false;
	}
	return true;
}

function matchesError(error: unknown, matcher: ErrorMatcher): boolean {
	if (typeof matcher === 'function') return matcher(error);
	const message = errorMessage(error);
	if (typeof matcher === 'string') return message.includes(matcher);
	matcher.lastIndex = 0;
	return matcher.test(message);
}

function normalizeResponseQuery(mode: OutcomeReaderMode, query: ResponseQuery | undefined): ResponseQuery | undefined {
	const record = assertQueryRecord(mode, 'response', query);
	assertKnownKeys(mode, 'response', record, RESPONSE_QUERY_KEYS);
	if (!record) return undefined;
	if (record.kind !== undefined && !isResponseKind(record.kind)) {
		throw invalidQueryError(mode, 'response', query, `received unsupported response kind ${formatValue(record.kind)}`);
	}
	if (record.ephemeral !== undefined && typeof record.ephemeral !== 'boolean') {
		throw invalidQueryError(mode, 'response', query, 'received non-boolean "ephemeral"');
	}
	return record as ResponseQuery;
}

function normalizeDenialQuery(mode: OutcomeReaderMode, query: DenialQuery | undefined): DenialQuery | undefined {
	const record = assertQueryRecord(mode, 'denial', query);
	assertKnownKeys(mode, 'denial', record, DENIAL_QUERY_KEYS);
	if (!record) return undefined;
	if (record.kind !== undefined && !isDenialKind(record.kind)) {
		throw invalidQueryError(mode, 'denial', query, `received unsupported denial kind ${formatValue(record.kind)}`);
	}
	if (record.middleware !== undefined && typeof record.middleware !== 'string') {
		throw invalidQueryError(mode, 'denial', query, 'received non-string "middleware"');
	}
	if (record.missing !== undefined) validateMissing(mode, query, record.missing);
	return record as DenialQuery;
}

function normalizeErrorQuery(
	mode: OutcomeReaderMode,
	query: ErrorQuery | ErrorMatcher | undefined,
): ErrorQuery | undefined {
	if (query === undefined) return undefined;
	if (isErrorMatcher(query)) return { match: query };
	const record = assertQueryRecord(mode, 'error', query);
	assertKnownKeys(mode, 'error', record, ERROR_QUERY_KEYS);
	if (!record) return undefined;
	if (record.match !== undefined && !isErrorMatcher(record.match)) {
		throw invalidQueryError(mode, 'error', query, 'received invalid "match"');
	}
	return record as ErrorQuery;
}

function validateMissing(mode: OutcomeReaderMode, query: unknown, missing: unknown): void {
	if (typeof missing === 'string') return;
	if (Array.isArray(missing) && missing.every(permission => typeof permission === 'string')) return;
	throw invalidQueryError(mode, 'denial', query, 'received invalid "missing"');
}

function assertQueryRecord(
	mode: OutcomeReaderMode,
	kind: OutcomeKind,
	query: unknown,
): Record<string, unknown> | undefined {
	if (query === undefined) return undefined;
	if (query && typeof query === 'object' && !Array.isArray(query) && !(query instanceof RegExp)) {
		return query as Record<string, unknown>;
	}
	throw invalidQueryError(mode, kind, query, 'expected a query object');
}

function assertKnownKeys(
	mode: OutcomeReaderMode,
	kind: OutcomeKind,
	query: Record<string, unknown> | undefined,
	allowed: readonly string[],
): void {
	if (!query) return;
	const unknown = Object.keys(query).filter(key => !allowed.includes(key));
	if (unknown.length === 0) return;
	const keyLabel =
		unknown.length === 1
			? `unknown query key ${JSON.stringify(unknown[0])}`
			: `unknown query keys ${unknown.map(key => JSON.stringify(key)).join(', ')}`;
	throw new OutcomeError(
		`${operation(mode, kind)} received ${keyLabel}.\nKnown ${kind} query keys: ${allowed.join(', ')}.`,
		{
			mode,
			kind,
			query,
			matches: [],
			candidates: [],
			reason: 'unknown-query-key',
		},
	);
}

function invalidQueryError(mode: OutcomeReaderMode, kind: OutcomeKind, query: unknown, reason: string): OutcomeError {
	return new OutcomeError(`${operation(mode, kind)} ${reason}.`, {
		mode,
		kind,
		query,
		matches: [],
		candidates: [],
		reason: 'invalid-query',
	});
}

function isResponseKind(value: unknown): value is ResponseKind {
	return RESPONSE_KINDS.includes(value as ResponseKind);
}

function isDenialKind(value: unknown): value is DispatchDenial['kind'] {
	return DENIAL_KINDS.includes(value as DispatchDenial['kind']);
}

function isErrorMatcher(value: unknown): value is ErrorMatcher {
	return typeof value === 'string' || value instanceof RegExp || typeof value === 'function';
}

function missingOutcomeError(
	kind: OutcomeKind,
	query: unknown,
	matches: readonly Candidate<unknown>[],
	scope: OutcomeScope,
): OutcomeError {
	const candidates = candidatesForKind(scope, kind);
	const queryText = describeCallArg(query);
	const base =
		matches.length === 0
			? `outcome(result).get.${kind}(${queryText}) found 0 ${plural(kind)}.`
			: `outcome(result).get.${kind}(${queryText}) found ${matches.length} ${plural(kind)}.`;
	const sections = [
		base,
		candidates.length > 0 ? `\n${candidateHeading(kind)}\n${candidates.join('\n')}` : `\n${debugOutcome(scope)}`,
		responseDiagnostics(kind, scope),
		errorDiagnostics(kind),
	].filter((section): section is string => section !== undefined);
	return new OutcomeError(sections.join('\n'), {
		mode: 'get',
		kind,
		query,
		matches: matches.map(match => match.summary),
		candidates,
	});
}

function responseDiagnostics(kind: OutcomeKind, scope: OutcomeScope): string | undefined {
	if (kind !== 'response') return undefined;
	const suggestions = [
		scope.denial
			? `\nIf the denial is the contract, use:\n  outcome(result).get.denial({ kind: ${formatValue(scope.denial.denialKind)} })`
			: undefined,
		scope.result.messages.length > 0
			? '\nIf the rendered UI is the contract, use:\n  rendered(result).get.message(...)'
			: undefined,
	].filter((section): section is string => section !== undefined);
	return suggestions.length > 0 ? suggestions.join('\n') : undefined;
}

function errorDiagnostics(kind: OutcomeKind): string | undefined {
	if (kind !== 'error') return undefined;
	return '\nIf you expected an unhandled command error, create the bot with:\n  createMockBot({ onCommandError: "capture" })';
}

function candidatesForKind(scope: OutcomeScope, kind: OutcomeKind): string[] {
	switch (kind) {
		case 'response':
			return scope.response?.events.map(event => `  ${summarizeResponseEvent(event)}`) ?? [];
		case 'denial':
			return scope.denial ? [`  ${summarizeDenial(scope.denial)}`] : [];
		case 'error':
			return scope.error ? [`  ${summarizeError(scope.error)}`] : [];
	}
}

function candidateHeading(kind: OutcomeKind): string {
	switch (kind) {
		case 'response':
			return 'Responses recorded:';
		case 'denial':
			return 'Denials recorded:';
		case 'error':
			return 'Errors recorded:';
	}
}

function debugOutcome(scope: OutcomeScope): string {
	const lines = [
		...(scope.response?.events.map(summarizeResponseEvent) ?? []),
		...(scope.denial ? [summarizeDenial(scope.denial)] : []),
		...(scope.error ? [summarizeError(scope.error)] : []),
		`rendered messages=${scope.result.messages.length}`,
	];
	return ['Outcome:', ...lines.map(line => `  ${line}`)].join('\n');
}

function summarizeResponse(response: OutcomeResponse): string {
	return response.events.map(summarizeResponseEvent).join(', ');
}

function summarizeResponseEvent(event: OutcomeResponseEvent): string {
	const parts = [`response ${event.kind}`];
	if (event.ephemeral !== undefined) parts.push(`ephemeral=${event.ephemeral}`);
	return parts.join(' ');
}

function summarizeDenial(denial: OutcomeDenial): string {
	const parts = [`denied ${denial.denialKind}`];
	if (denial.middleware) parts.push(`middleware=${denial.middleware}`);
	if (denial.missing.length > 0) parts.push(`missing=[${denial.missing.join(', ')}]`);
	return parts.join(' ');
}

function summarizeError(captured: OutcomeCapturedError): string {
	return `error ${describeError(captured.error)}`;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return errorMessage(error);
}

function errorMessage(error: unknown): string {
	try {
		return String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}

function describeCallArg(query: unknown): string {
	return query === undefined ? '' : describeQuery(query);
}

function describeQuery(query: unknown): string {
	if (isErrorMatcher(query)) return formatValue(query);
	if (!query || typeof query !== 'object') return formatValue(query);
	const entries = Object.entries(query).map(([key, value]) => `${key}: ${formatValue(value)}`);
	return `{ ${entries.join(', ')} }`;
}

function formatValue(value: unknown): string {
	if (value instanceof RegExp) return String(value);
	if (typeof value === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`;
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`;
	if (value && typeof value === 'object') return '{...}';
	return String(value);
}

function operation(mode: OutcomeReaderMode, kind: OutcomeKind): string {
	return `outcome(result).${mode}.${kind}(...)`;
}

function plural(kind: OutcomeKind): string {
	switch (kind) {
		case 'response':
			return 'responses';
		case 'denial':
			return 'denials';
		case 'error':
			return 'errors';
	}
}
