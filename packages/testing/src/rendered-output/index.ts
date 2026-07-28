import { asRecord, type EmbedView, numberValue } from '../bot/state';
import { dispatchFactsOf } from './dispatch-facts';
import { normalizeOutput } from './normalize';
import {
	type AnyComponentView,
	type ButtonQuery,
	type ButtonView,
	type Candidate,
	type CanonicalComponent,
	type CanonicalEmbed,
	type CanonicalMessage,
	type CanonicalModal,
	type CapturedErrorView,
	COMPONENT,
	type ComponentKind,
	type ComponentQuery,
	type ComponentQueryArg,
	type ComponentView,
	type ContainerFinder,
	type ContainerQuery,
	type ContainerView,
	type ContentQuery,
	type ContentView,
	type DenialQuery,
	type DenialView,
	type DispatchFacts,
	type EmbedQuery,
	type ErrorMatcher,
	type ErrorQuery,
	type FieldQuery,
	type FileUploadQuery,
	type FileUploadView,
	type Finder,
	type InputQuery,
	type InternalKind,
	type LabelQuery,
	type LabelView,
	type MediaQuery,
	type MediaView,
	type ModalQuery,
	type OutputFinder,
	type ReaderMode,
	type RenderedMessage,
	type RenderedMessageQuery,
	type RenderedModal,
	type RenderedOptions,
	type RenderedOutput,
	RenderedOutputError,
	type RenderedSubject,
	type Result,
	type Scope,
	SELECT_NAME,
	type SectionQuery,
	type SectionView,
	type SelectOptionQuery,
	type SelectOptionView,
	type SelectQuery,
	type SelectView,
	type SeparatorQuery,
	type SeparatorView,
	STYLE_NAME,
	type TextInputView,
	type TextMatcher,
	type UnknownComponentView,
} from './types';

export type * from './types';
export { RenderedOutputError } from './types';

export function rendered(subject: RenderedSubject, options: RenderedOptions = {}): RenderedOutput {
	assertSubject(subject);
	const canonical = normalizeOutput(subject, options);
	const dispatch = dispatchFactsOf(subject);
	const scope: Scope = {
		label: 'rendered',
		messages: canonical.messages,
		modals: canonical.modals,
		components: [
			...canonical.messages.flatMap(message => message.components),
			...canonical.modals.flatMap(modal => modal.components),
		],
		...(dispatch === undefined ? {} : { dispatch }),
	};
	return {
		raw: {
			messages: () => canonical.messages.map(message => message.raw),
			modals: () => canonical.modals.map(modal => modal.raw),
		},
		get: makeOutputFinder('get', scope),
		query: makeOutputFinder('query', scope),
		all: makeOutputFinder('all', scope),
		debug: () => debugOutput(canonical, dispatch),
	};
}

/**
 * Reject the subjects that would otherwise normalize into an empty scope, where the resulting "found 0"
 * reads like a product bug. A forgotten `await` is the common one — every stateful verb is async — so it
 * gets its own sentence rather than being folded into "not an object".
 */
function assertSubject(subject: RenderedSubject): void {
	if (subject == null || (typeof subject !== 'object' && typeof subject !== 'function')) {
		throw new TypeError(
			`rendered(): expected a MockBot, Actor, DispatchResult, mock context, or message payload, got ${describeSubject(subject)}.`,
		);
	}
	// `instanceof Promise`, not "is thenable": a parked `Dispatch` is a documented subject and is itself
	// PromiseLike. Only the native promise an un-awaited `await`-less call returns is the mistake.
	if (subject instanceof Promise) {
		throw new TypeError(
			'rendered(): got a promise, not rendered output. Every stateful verb is async — await the dispatch ' +
				'first, e.g. rendered(await bot.slash(...)). A parked Dispatch needs no await.',
		);
	}
	assertNotBareBuilder(subject);
}

/** Message-body keys. A payload carrying any of these is a message, whatever else it also carries. */
const MESSAGE_KEYS = [
	'content',
	'embeds',
	'components',
	'attachments',
	'files',
	'poll',
	'flags',
	'tts',
	'allowed_mentions',
	'sticker_ids',
	'message_reference',
] as const;
const EMBED_KEYS = ['title', 'description', 'fields', 'color', 'footer', 'author', 'image', 'thumbnail'] as const;

/**
 * A component or embed builder passed on its own is normalized as if it were a message, so an ActionRow's
 * `components` read as a message's rows and an Embed's fields match nothing — the reader answers "0 buttons"
 * for output that plainly has one. That is the silent-empty scope this whole function exists to reject, so it
 * belongs here rather than in the docs.
 */
function assertNotBareBuilder(subject: object): void {
	const toJSON = (subject as { toJSON?: unknown }).toJSON;
	if (typeof toJSON !== 'function') return;
	const body: unknown = (subject as { toJSON(): unknown }).toJSON();
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return;
	const record = body as Record<string, unknown>;
	// `type` is checked before the message keys, not after: an ActionRow serializes to
	// `{ type: 1, components: [...] }`, and `components` alone would read as a message body. A message payload
	// never carries a top-level numeric `type`.
	const kind =
		typeof record.type === 'number'
			? 'component'
			: MESSAGE_KEYS.some(key => key in record)
				? undefined
				: EMBED_KEYS.some(key => key in record)
					? 'embed'
					: undefined;
	if (!kind) return;
	throw new TypeError(
		`rendered(): got a bare ${kind} builder, which has no message to read it from — every query would answer ` +
			`"found 0". Wrap it the way the handler sends it, e.g. rendered({ ${kind === 'embed' ? 'embeds: [embed]' : 'components: [row]'} }).`,
	);
}

function describeSubject(subject: unknown): string {
	if (subject === null) return 'null';
	if (subject === undefined) return 'undefined';
	if (typeof subject === 'string') return `the string ${JSON.stringify(subject)}`;
	return `the ${typeof subject} ${String(subject)}`;
}

function makeFinder<Mode extends ReaderMode>(mode: Mode, scope: Scope): Finder<Mode> {
	return {
		message: query => resolve(mode, 'message', query, messageCandidates(scope, query), scope, toRenderedMessage),
		modal: query => resolve(mode, 'modal', query, modalCandidates(scope, query), scope, toRenderedModal),
		embed: query => resolve(mode, 'embed', query, embedCandidates(scope, query), scope, candidate => candidate.view),
		button: query => componentResult(mode, scope, 'button', query),
		select: query => componentResult(mode, scope, 'select', query),
		input: query => componentResult(mode, scope, 'input', query),
		container: query => componentResult(mode, scope, 'container', query),
		component: (kind, query) => componentResult(mode, scope, kind, query),
	} as Finder<Mode>;
}

/**
 * The reader over a whole subject. `denial` and `error` are dispatch-level, so they exist here and not on the
 * scoped finders; both go through the same {@link resolve} cardinality contract as every rendered kind.
 */
function makeOutputFinder<Mode extends ReaderMode>(mode: Mode, scope: Scope): OutputFinder<Mode> {
	return {
		...makeFinder(mode, scope),
		denial: (query?: DenialQuery) => {
			assertDispatchSubject(mode, 'denial', scope);
			return resolve(mode, 'denial', query, denialCandidates(scope, query), scope, identity);
		},
		error: (query?: ErrorQuery | ErrorMatcher) => {
			assertDispatchSubject(mode, 'error', scope);
			return resolve(mode, 'error', query, errorCandidates(scope, query), scope, identity);
		},
	} as OutputFinder<Mode>;
}

/**
 * A subject that can never be denied is a mistake about the subject, not a query that matched nothing — the
 * same class of mistake {@link assertSubject} rejects, so it fails the same way. Reporting "matched none of 0
 * denials" for a `MockBot` would make `query`/`all` pass vacuously, which is what this reader exists to stop.
 */
function assertDispatchSubject(mode: ReaderMode, kind: 'denial' | 'error', scope: Scope): void {
	if (scope.dispatch) return;
	const carries = kind === 'denial' ? 'a denial' : 'a captured error';
	throw new TypeError(
		`rendered().${mode}.${kind}(): only a DispatchResult carries ${carries}. A MockBot, an actor, a parked flow, ` +
			`a mock context and a raw payload carry rendered output only — read it off the awaited dispatch, ` +
			`e.g. rendered(await bot.slash(...)).${mode}.${kind}().`,
	);
}

function identity<T>(value: T): T {
	return value;
}

function makeContainerFinder<Mode extends ReaderMode>(mode: Mode, scope: Scope): ContainerFinder<Mode> {
	return {
		...makeFinder(mode, scope),
		content: query => componentResult(mode, scope, 'content', query),
		section: query => componentResult(mode, scope, 'section', query),
		media: query => componentResult(mode, scope, 'media', query),
	} as ContainerFinder<Mode>;
}

function componentResult<Mode extends ReaderMode, K extends ComponentKind>(
	mode: Mode,
	scope: Scope,
	kind: K,
	query: ComponentQueryArg<K> | undefined,
): Result<Mode, ComponentView<K>> {
	const candidates = componentCandidates(scope, kind, query);
	return resolve(mode, kind, query, candidates, scope, toComponentView) as Result<Mode, ComponentView<K>>;
}

function resolve<Mode extends ReaderMode, Canonical, View>(
	mode: Mode,
	kind: string,
	query: unknown,
	candidates: readonly Candidate<Canonical>[],
	scope: Scope,
	toView: (value: Canonical) => View,
): Result<Mode, View> {
	// Same contract as world.query: zero is fine, more than one is a question the query did not answer.
	// Returning the first was the only reader variant that could make an ambiguous match pass green.
	if (mode === 'query') {
		if (candidates.length > 1) throw renderedOutputError(kind, query, candidates, scope);
		return (candidates[0] ? toView(candidates[0].value) : undefined) as Result<Mode, View>;
	}
	if (mode === 'all') return candidates.map(candidate => toView(candidate.value)) as Result<Mode, View>;
	if (candidates.length === 1) return toView(candidates[0].value) as Result<Mode, View>;
	throw renderedOutputError(kind, query, candidates, scope);
}

function renderedOutputError(
	kind: string,
	query: unknown,
	matches: readonly Candidate<unknown>[],
	scope: Scope,
): RenderedOutputError {
	const allCandidates = candidatesForKind(scope, kind);
	const renderedMatches = matches.map(candidate => `  ${candidate.summary}`);
	const renderedCandidates = allCandidates.map(candidate => `  ${candidate.summary}`);
	const queryText = describeQuery(query);
	// "found 0 embeds" reads as "there were no embeds" and sends the author looking for a rendering failure
	// when the matcher is what's wrong. Say how many were there, so zero-rendered and zero-matched differ.
	const base =
		matches.length === 0
			? `${scope.label}.get.${kind}(${queryText}) matched none of ${allCandidates.length} ${plural(kind)}.`
			: `${scope.label}.get.${kind}(${queryText}) found ${matches.length} ${plural(kind)}; get.${kind} requires exactly one.`;
	const sections = [
		base,
		matches.length > 1 ? '\nMatches:\n' + renderedMatches.join('\n') : undefined,
		matches.length === 0 && renderedCandidates.length
			? `\n${capitalize(plural(kind))} ${recordedVerb(kind)}:\n${renderedCandidates.join('\n')}`
			: undefined,
		// Nothing of the queried kind exists, so the per-kind list above is empty and would leave a bare
		// headline. Fall back to the whole scope: "you asked for an embed, here is the content that was sent".
		matches.length === 0 && renderedCandidates.length === 0 ? scopeFallback(kind, scope) : undefined,
		containerContentDiagnostics(kind, query, scope),
		modalFieldDiagnostics(kind, scope),
		denialDiagnostics(kind, scope),
		errorCaptureDiagnostics(kind, scope),
		kind !== 'message' && !isDispatchKind(kind) && scope.messages.length > 1
			? `\nUse a scope first, for example rendered(result).get.message({ content: /.../ }).get.${kind}(...).`
			: undefined,
		matches.length > 1 ? `\nOr use:\n  ${scope.label}.all.${kind}(${queryText})` : undefined,
	].filter((part): part is string => part !== undefined);
	return new RenderedOutputError(sections.join('\n'), {
		mode: 'get',
		kind,
		query,
		scope: scope.label,
		matches: renderedMatches,
		candidates: renderedCandidates,
	});
}

function scopeFallback(kind: string, scope: Scope): string {
	const dump = debugOutput({ messages: scope.messages, modals: scope.modals }, scope.dispatch);
	// A dispatch kind has no per-kind candidate list to fall back on, so say the fact and show what did happen.
	if (kind === 'denial') return `\nThe dispatch was not denied; it reached the handler. ${dump}`;
	if (kind === 'error') return `\nThe dispatch captured no error. ${dump}`;
	const nothing = `\nNothing of kind "${kind}" was rendered.`;
	return scope.messages.length === 0 && scope.modals.length === 0
		? `${nothing} The subject rendered no output at all.`
		: `${nothing} ${dump}`;
}

/**
 * A miss on a dispatch that never reached the handler is usually the denial being the contract, not a
 * rendering bug — name the read that passes rather than leave the author hunting the handler for output it
 * never got to write.
 */
function denialDiagnostics(kind: string, scope: Scope): string | undefined {
	const denial = scope.dispatch?.denial;
	if (!denial || kind === 'denial') return undefined;
	return (
		'\nThe dispatch was denied before the handler ran. If the denial is the contract, use:\n' +
		`  rendered(result).get.denial({ kind: ${JSON.stringify(denial.denialKind)} })`
	);
}

function errorCaptureDiagnostics(kind: string, scope: Scope): string | undefined {
	if (kind !== 'error' || scope.dispatch?.error !== undefined) return undefined;
	return (
		'\nIf you expected an unhandled command error, create the bot with:\n' +
		'  createMockBot({ onCommandError: "capture" })'
	);
}

function containerContentDiagnostics(kind: string, query: unknown, scope: Scope): string | undefined {
	if (kind !== 'message' || !query || typeof query !== 'object' || Array.isArray(query)) return undefined;
	const content = (query as { content?: unknown }).content;
	if (content === undefined) return undefined;
	const matches = componentCandidates(scope, 'content', { text: content as TextMatcher });
	if (matches.length === 0) return undefined;
	return `\nContainer content matched:\n${matches.map(match => `  ${match.summary}`).join('\n')}`;
}

function modalFieldDiagnostics(kind: string, scope: Scope): string | undefined {
	if (kind !== 'input' && kind !== 'select' && kind !== 'fileUpload') return undefined;
	const sections = scope.modals
		.map(modal => {
			const fields = flattenComponents(modal.components).filter(
				component => component.kind === 'input' || component.kind === 'select' || component.kind === 'fileUpload',
			);
			if (fields.length === 0) return undefined;
			const title = modal.customId ?? modal.title ?? String(modal.index);
			return `\nFields in modal "${title}":\n${fields.map(fieldSummary).join('\n')}`;
		})
		.filter((section): section is string => section !== undefined);
	return sections.length > 0 ? sections.join('\n') : undefined;
}

function fieldSummary(component: CanonicalComponent): string {
	const id = component.customId ? `#${component.customId}` : '';
	const label = component.label ? ` label=${JSON.stringify(component.label)}` : '';
	return `  ${component.kind}${id}${label}`;
}

function messageCandidates(scope: Scope, query: RenderedMessageQuery | undefined): Candidate<CanonicalMessage>[] {
	assertKnownKeys(query, ['id', 'channelId', 'content', 'ephemeral', 'transport'], 'message');
	return scope.messages
		.filter(message => messageMatches(message, query))
		.map(message => ({
			value: message,
			path: message.path,
			summary: summarizeMessage(message),
		}));
}

function modalCandidates(scope: Scope, query: ModalQuery | string | undefined): Candidate<CanonicalModal>[] {
	const normalized = typeof query === 'string' ? { customId: query } : query;
	assertKnownKeys(normalized, ['customId', 'title'], 'modal');
	return scope.modals
		.filter(modal => modalMatches(modal, normalized))
		.map(modal => ({
			value: modal,
			path: modal.path,
			summary: summarizeModal(modal),
		}));
}

function embedCandidates(scope: Scope, query: EmbedQuery | undefined): Candidate<CanonicalEmbed>[] {
	assertKnownKeys(query, ['title', 'description', 'contains', 'author', 'footer', 'color', 'field'], 'embed');
	return scope.messages
		.flatMap(message => message.embeds)
		.filter(embed => embedMatches(embed.view, query))
		.map(embed => ({ value: embed, path: embed.path, summary: summarizeEmbed(embed) }));
}

function componentCandidates<K extends ComponentKind>(
	scope: Scope,
	kind: K,
	query: ComponentQueryArg<K> | undefined,
): Candidate<CanonicalComponent>[] {
	const normalized = shorthandQuery(kind, query);
	assertComponentKeys(kind, normalized);
	return flattenComponents(scope.components)
		.filter(component => component.kind === kind)
		.filter(component => componentMatchesKind(component, kind, normalized))
		.map(component => ({ value: component, path: component.path, summary: summarizeComponent(component) }));
}

function denialCandidates(scope: Scope, query: DenialQuery | undefined): Candidate<DenialView>[] {
	assertKnownKeys(query, ['kind', 'middleware', 'missing'], 'denial');
	const denial = scope.dispatch?.denial;
	if (!denial || !denialMatches(denial, query)) return [];
	return [{ value: denial, path: 'denial', summary: summarizeDenial(denial) }];
}

function errorCandidates(scope: Scope, query: ErrorQuery | ErrorMatcher | undefined): Candidate<CapturedErrorView>[] {
	const normalized = normalizeErrorQuery(query);
	const captured = scope.dispatch?.error;
	if (!captured) return [];
	if (normalized?.match !== undefined && !matchesError(captured.error, normalized.match)) return [];
	return [{ value: captured, path: 'error', summary: summarizeError(captured) }];
}

function candidatesForKind(scope: Scope, kind: string): Candidate<unknown>[] {
	if (kind === 'message') return messageCandidates(scope, undefined);
	if (kind === 'modal') return modalCandidates(scope, undefined);
	if (kind === 'embed') return embedCandidates(scope, undefined);
	if (kind === 'denial') return denialCandidates(scope, undefined);
	if (kind === 'error') return errorCandidates(scope, undefined);
	if (isComponentKind(kind)) return componentCandidates(scope, kind, undefined);
	return [];
}

function isDispatchKind(kind: string): boolean {
	return kind === 'denial' || kind === 'error';
}

function flattenComponents(components: readonly CanonicalComponent[]): CanonicalComponent[] {
	const out: CanonicalComponent[] = [];
	const visit = (component: CanonicalComponent) => {
		out.push(component);
		for (const child of component.children) visit(child);
		if (component.accessory) visit(component.accessory);
	};
	for (const component of components) visit(component);
	return out;
}

function isComponentKind(kind: string): kind is ComponentKind {
	return [
		'button',
		'select',
		'input',
		'container',
		'content',
		'section',
		'media',
		'separator',
		'label',
		'fileUpload',
	].includes(kind);
}

function shorthandQuery<K extends ComponentKind>(
	kind: K,
	query: ComponentQueryArg<K> | undefined,
): ComponentQuery<K> | undefined {
	if (typeof query !== 'string') return query as ComponentQuery<K> | undefined;
	if (kind === 'button' || kind === 'select' || kind === 'input' || kind === 'fileUpload') {
		return { customId: query } as ComponentQuery<K>;
	}
	throw new TypeError(`rendered.${kind}: string shorthand is only supported for custom_id based component kinds.`);
}

function messageMatches(message: CanonicalMessage, query: RenderedMessageQuery | undefined): boolean {
	if (!query) return true;
	if (query.id !== undefined && !matchesText(message.id, query.id)) return false;
	if (query.channelId !== undefined && !matchesText(message.channelId, query.channelId)) return false;
	if (query.content !== undefined && !matchesText(message.content, query.content)) return false;
	if (query.ephemeral !== undefined && (message.visibility === 'ephemeral') !== query.ephemeral) return false;
	if (query.transport !== undefined && message.transport !== query.transport) return false;
	return true;
}

function modalMatches(modal: CanonicalModal, query: ModalQuery | undefined): boolean {
	if (!query) return true;
	if (query.customId !== undefined && !matchesText(modal.customId, query.customId)) return false;
	if (query.title !== undefined && !matchesText(modal.title, query.title)) return false;
	return true;
}

function embedMatches(embed: EmbedView, query: EmbedQuery | undefined): boolean {
	if (!query) return true;
	if (query.title !== undefined && !matchesText(embed.title, query.title)) return false;
	if (query.description !== undefined && !matchesText(embed.description, query.description)) return false;
	if (query.contains !== undefined && !matchesText(embedText(embed), query.contains)) return false;
	if (query.author !== undefined && !matchesText(embed.author?.name, query.author)) return false;
	if (query.footer !== undefined && !matchesText(embed.footer?.text, query.footer)) return false;
	if (query.color !== undefined && embed.color !== query.color) return false;
	if (query.field !== undefined) {
		const fieldQueries = Array.isArray(query.field) ? query.field : [query.field];
		for (const fieldQuery of fieldQueries) {
			if (!embed.fields.some(field => fieldMatches(field, fieldQuery))) return false;
		}
	}
	return true;
}

function fieldMatches(field: EmbedView['fields'][number], query: FieldQuery): boolean {
	assertKnownKeys(query, ['name', 'value', 'inline'], 'field');
	if (query.name !== undefined && !matchesText(field.name, query.name)) return false;
	if (query.value !== undefined && !matchesText(field.value, query.value)) return false;
	if (query.inline !== undefined && (field.inline ?? false) !== query.inline) return false;
	return true;
}

function componentMatchesKind<K extends ComponentKind>(
	component: CanonicalComponent,
	kind: K,
	query: ComponentQuery<K> | undefined,
): boolean {
	if (!query) return true;
	if (kind === 'button') return buttonMatches(component, query as ButtonQuery);
	if (kind === 'select') return selectMatches(component, query as SelectQuery);
	if (kind === 'input') return inputMatches(component, query as InputQuery);
	if (kind === 'container') return containerMatches(component, query as ContainerQuery);
	if (kind === 'content') return contentMatches(component, query as ContentQuery);
	if (kind === 'section') return sectionMatches(component, query as SectionQuery);
	if (kind === 'media') return mediaMatches(component, query as MediaQuery);
	if (kind === 'separator') return separatorMatches(component, query as SeparatorQuery);
	if (kind === 'label') return labelMatches(component, query as LabelQuery);
	if (kind === 'fileUpload') return fileUploadMatches(component, query as FileUploadQuery);
	return true;
}

function buttonMatches(component: CanonicalComponent, query: ButtonQuery): boolean {
	if (query.customId !== undefined && !matchesText(component.customId, query.customId)) return false;
	if (query.label !== undefined && !matchesText(component.label, query.label)) return false;
	if (query.disabled !== undefined && (component.disabled ?? false) !== query.disabled) return false;
	if (query.style !== undefined && component.style !== styleNumber(query.style)) return false;
	if (query.url !== undefined && !matchesText(component.url, query.url)) return false;
	return true;
}

function selectMatches(component: CanonicalComponent, query: SelectQuery): boolean {
	if (query.customId !== undefined && !matchesText(component.customId, query.customId)) return false;
	if (query.label !== undefined && !matchesText(component.label, query.label)) return false;
	if (query.placeholder !== undefined && !matchesText(component.placeholder, query.placeholder)) return false;
	if (query.disabled !== undefined && (component.disabled ?? false) !== query.disabled) return false;
	if (query.type !== undefined && component.discordType !== SELECT_NAME[query.type]) return false;
	if (query.option !== undefined) {
		const queries = Array.isArray(query.option) ? query.option : [query.option];
		for (const optionQuery of queries) {
			assertKnownKeys(optionQuery, ['label', 'value', 'description'], 'select option');
			if (!component.options.some(option => selectOptionMatches(option, optionQuery))) return false;
		}
	}
	return true;
}

function selectOptionMatches(option: SelectOptionView, query: SelectOptionQuery): boolean {
	if (query.label !== undefined && !matchesText(option.label, query.label)) return false;
	if (query.value !== undefined && !matchesText(option.value, query.value)) return false;
	if (query.description !== undefined && !matchesText(option.description, query.description)) return false;
	return true;
}

function inputMatches(component: CanonicalComponent, query: InputQuery): boolean {
	if (query.customId !== undefined && !matchesText(component.customId, query.customId)) return false;
	if (query.label !== undefined && !matchesText(component.label, query.label)) return false;
	if (query.required !== undefined && (component.required ?? false) !== query.required) return false;
	if (query.value !== undefined && !matchesText(component.value, query.value)) return false;
	if (query.style !== undefined && component.style !== query.style) return false;
	return true;
}

function containerMatches(component: CanonicalComponent, query: ContainerQuery): boolean {
	if (query.id !== undefined && component.id !== query.id) return false;
	if (query.accentColor !== undefined && numberValue(asRecord(component.raw.body).accent_color) !== query.accentColor) {
		return false;
	}
	const contentQuery = query.content;
	if (
		contentQuery !== undefined &&
		!descendantContent(component).some(content => matchesText(content.text, contentQuery))
	) {
		return false;
	}
	if (query.has !== undefined) {
		const refs = Array.isArray(query.has) ? query.has : [query.has];
		const scope = componentScope(component, `${component.path}`);
		for (const ref of refs) {
			if (componentCandidates(scope, ref.kind, ref.query as never).length === 0) return false;
		}
	}
	return true;
}

function contentMatches(component: CanonicalComponent, query: ContentQuery): boolean {
	return query.text === undefined || matchesText(component.text, query.text);
}

function sectionMatches(component: CanonicalComponent, query: SectionQuery): boolean {
	const contentQuery = query.content;
	if (
		contentQuery !== undefined &&
		!descendantContent(component).some(content => matchesText(content.text, contentQuery))
	) {
		return false;
	}
	if (query.accessory !== undefined) {
		if (!component.accessory) return false;
		const scope = componentScope(component.accessory, `${component.path}.accessory`);
		if (componentCandidates(scope, query.accessory.kind, query.accessory.query as never).length === 0) return false;
	}
	return true;
}

function mediaMatches(component: CanonicalComponent, query: MediaQuery): boolean {
	if (query.url !== undefined && !matchesText(component.url, query.url)) return false;
	if (query.contentType !== undefined && !matchesText(component.contentType, query.contentType)) return false;
	if (query.filename !== undefined && !matchesText(component.filename, query.filename)) return false;
	return true;
}

function separatorMatches(component: CanonicalComponent, query: SeparatorQuery): boolean {
	const raw = asRecord(component.raw.body);
	if (query.divider !== undefined && (raw.divider ?? true) !== query.divider) return false;
	if (query.spacing !== undefined && numberValue(raw.spacing) !== query.spacing) return false;
	return true;
}

function labelMatches(component: CanonicalComponent, query: LabelQuery): boolean {
	if (query.label !== undefined && !matchesText(component.label, query.label)) return false;
	if (query.description !== undefined && !matchesText(component.description, query.description)) return false;
	return true;
}

function fileUploadMatches(component: CanonicalComponent, query: FileUploadQuery): boolean {
	if (query.customId !== undefined && !matchesText(component.customId, query.customId)) return false;
	if (query.label !== undefined && !matchesText(component.label, query.label)) return false;
	if (query.required !== undefined && (component.required ?? false) !== query.required) return false;
	return true;
}

function styleNumber(style: ButtonQuery['style']): number | undefined {
	return typeof style === 'number' ? style : style === undefined ? undefined : STYLE_NAME[style];
}

function denialMatches(denial: DenialView, query: DenialQuery | undefined): boolean {
	if (!query) return true;
	if (query.kind !== undefined && denial.denialKind !== query.kind) return false;
	if (query.middleware !== undefined && denial.middleware !== query.middleware) return false;
	if (query.missing !== undefined) {
		const missing = typeof query.missing === 'string' ? [query.missing] : query.missing;
		if (!missing.every(permission => denial.missing.includes(permission))) return false;
	}
	return true;
}

function normalizeErrorQuery(query: ErrorQuery | ErrorMatcher | undefined): ErrorQuery | undefined {
	if (query === undefined) return undefined;
	if (isErrorMatcher(query)) return { match: query };
	assertKnownKeys(query, ['match'], 'error');
	return query;
}

function isErrorMatcher(value: unknown): value is ErrorMatcher {
	return typeof value === 'string' || value instanceof RegExp || typeof value === 'function';
}

function matchesError(error: unknown, matcher: ErrorMatcher): boolean {
	if (typeof matcher === 'function') return matcher(error);
	const message = errorText(error);
	if (typeof matcher === 'string') return message.includes(matcher);
	matcher.lastIndex = 0;
	return matcher.test(message);
}

function matchesText(value: string | undefined, matcher: TextMatcher): boolean {
	if (value === undefined) return false;
	if (typeof matcher === 'string') return value === matcher;
	if (typeof matcher === 'function') return matcher(value);
	matcher.lastIndex = 0;
	return matcher.test(value);
}

function embedText(embed: EmbedView): string {
	return [
		embed.title,
		embed.description,
		embed.author?.name,
		embed.footer?.text,
		...embed.fields.flatMap(field => [field.name, field.value]),
	]
		.filter((value): value is string => typeof value === 'string')
		.join('\n');
}

function assertComponentKeys(kind: ComponentKind, query: unknown): void {
	const keys: Record<ComponentKind, readonly string[]> = {
		button: ['customId', 'label', 'disabled', 'style', 'url'],
		select: ['customId', 'label', 'placeholder', 'disabled', 'type', 'option'],
		input: ['customId', 'label', 'required', 'value', 'style'],
		container: ['id', 'accentColor', 'content', 'has'],
		content: ['text'],
		section: ['content', 'accessory'],
		media: ['url', 'contentType', 'filename'],
		separator: ['divider', 'spacing'],
		label: ['label', 'description'],
		fileUpload: ['customId', 'label', 'required'],
	};
	assertKnownKeys(query, keys[kind], kind);
}

function assertKnownKeys(query: unknown, allowed: readonly string[], kind: string): void {
	if (!query || typeof query !== 'object' || query instanceof RegExp || Array.isArray(query)) return;
	const unknown = Object.keys(query).filter(key => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new TypeError(`rendered.${kind}: unknown query key(s): ${unknown.join(', ')}.`);
	}
}

function toRenderedMessage(message: CanonicalMessage): RenderedMessage {
	const scope: Scope = componentScopeFromParts(`message(${message.path})`, [message], [], message.components);
	return {
		kind: 'message',
		path: message.path,
		raw: message.raw,
		...(message.id === undefined ? {} : { id: message.id }),
		...(message.channelId === undefined ? {} : { channelId: message.channelId }),
		transport: message.transport,
		...(message.content === undefined ? {} : { content: message.content }),
		ephemeral: message.visibility === 'ephemeral',
		...(message.flags === undefined ? {} : { flags: message.flags }),
		embeds: message.embeds.map(embed => embed.view),
		components: message.components.map(toComponentView),
		files: message.files,
		history: message.history,
		get: makeFinder('get', scope),
		query: makeFinder('query', scope),
		all: makeFinder('all', scope),
	};
}

function toRenderedModal(modal: CanonicalModal): RenderedModal {
	const scope: Scope = componentScopeFromParts(
		`modal(${modal.customId ?? modal.index})`,
		[],
		[modal],
		modal.components,
	);
	return {
		kind: 'modal',
		path: modal.path,
		raw: modal.raw,
		...(modal.customId === undefined ? {} : { customId: modal.customId }),
		...(modal.title === undefined ? {} : { title: modal.title }),
		components: modal.components.map(toComponentView),
		get: makeFinder('get', scope),
		query: makeFinder('query', scope),
		all: makeFinder('all', scope),
	};
}

function toComponentView(component: CanonicalComponent): AnyComponentView {
	if (component.kind === 'button') return buttonView(component);
	if (component.kind === 'select') return selectView(component);
	if (component.kind === 'input') return inputView(component);
	if (component.kind === 'fileUpload') return fileUploadView(component);
	if (component.kind === 'container') return containerView(component);
	if (component.kind === 'content') return contentView(component);
	if (component.kind === 'section') return sectionView(component);
	if (component.kind === 'media') return mediaView(component);
	if (component.kind === 'separator') return separatorView(component);
	if (component.kind === 'label') return labelView(component);
	return unknownView(component);
}

function buttonView(component: CanonicalComponent): ButtonView {
	return {
		kind: 'button',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.customId === undefined ? {} : { customId: component.customId }),
		...(component.label === undefined ? {} : { label: component.label }),
		disabled: component.disabled ?? false,
		...(component.style === undefined ? {} : { style: component.style }),
		...(component.url === undefined ? {} : { url: component.url }),
	};
}

function selectView(component: CanonicalComponent): SelectView {
	return {
		kind: 'select',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.customId === undefined ? {} : { customId: component.customId }),
		...(component.label === undefined ? {} : { label: component.label }),
		...(component.description === undefined ? {} : { description: component.description }),
		...(component.placeholder === undefined ? {} : { placeholder: component.placeholder }),
		disabled: component.disabled ?? false,
		type: selectName(component.discordType),
		options: component.options,
	};
}

function inputView(component: CanonicalComponent): TextInputView {
	return {
		kind: 'input',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.customId === undefined ? {} : { customId: component.customId }),
		...(component.label === undefined ? {} : { label: component.label }),
		...(component.description === undefined ? {} : { description: component.description }),
		required: component.required ?? false,
		...(component.value === undefined ? {} : { value: component.value }),
		...(component.style === undefined ? {} : { style: component.style }),
	};
}

function fileUploadView(component: CanonicalComponent): FileUploadView {
	return {
		kind: 'fileUpload',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.customId === undefined ? {} : { customId: component.customId }),
		...(component.label === undefined ? {} : { label: component.label }),
		...(component.description === undefined ? {} : { description: component.description }),
		required: component.required ?? false,
	};
}

function containerView(component: CanonicalComponent): ContainerView {
	const scope = componentScope(component, `container(${component.path})`);
	return {
		kind: 'container',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(numberValue(asRecord(component.raw.body).accent_color) === undefined
			? {}
			: { accentColor: numberValue(asRecord(component.raw.body).accent_color) }),
		content: descendantContent(component).map(contentView),
		sections: descendantComponents(component, 'section').map(sectionView),
		media: descendantComponents(component, 'media').map(mediaView),
		components: component.children.map(toComponentView),
		get: makeContainerFinder('get', scope),
		query: makeContainerFinder('query', scope),
		all: makeContainerFinder('all', scope),
	};
}

function contentView(component: CanonicalComponent): ContentView {
	return {
		kind: 'content',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		text: component.text ?? '',
	};
}

function sectionView(component: CanonicalComponent): SectionView {
	const scope = componentScope(component, `section(${component.path})`);
	return {
		kind: 'section',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		content: descendantContent(component).map(contentView),
		media: descendantComponents(component, 'media').map(mediaView),
		components: [...component.children, ...(component.accessory ? [component.accessory] : [])].map(toComponentView),
		get: makeContainerFinder('get', scope),
		query: makeContainerFinder('query', scope),
		all: makeContainerFinder('all', scope),
		accessory: () => {
			if (!component.accessory) {
				throw new RenderedOutputError(`section.accessory() found no accessory at ${component.path}.`, {
					mode: 'get',
					kind: 'accessory',
					query: undefined,
					scope: component.path,
					matches: [],
					candidates: [],
				});
			}
			const accessoryScope = componentScope(component.accessory, `${component.path}.accessory`);
			return {
				raw: component.accessory.raw,
				get: makeFinder('get', accessoryScope),
				query: makeFinder('query', accessoryScope),
				all: makeFinder('all', accessoryScope),
			};
		},
	};
}

function mediaView(component: CanonicalComponent): MediaView {
	return {
		kind: 'media',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.url === undefined ? {} : { url: component.url }),
		...(component.contentType === undefined ? {} : { contentType: component.contentType }),
		...(component.filename === undefined ? {} : { filename: component.filename }),
		...(component.description === undefined ? {} : { description: component.description }),
	};
}

function separatorView(component: CanonicalComponent): SeparatorView {
	const raw = asRecord(component.raw.body);
	return {
		kind: 'separator',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(typeof raw.divider === 'boolean' ? { divider: raw.divider } : {}),
		...(numberValue(raw.spacing) === undefined ? {} : { spacing: numberValue(raw.spacing) }),
	};
}

function labelView(component: CanonicalComponent): LabelView {
	return {
		kind: 'label',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.label === undefined ? {} : { label: component.label }),
		...(component.description === undefined ? {} : { description: component.description }),
		...(component.children[0] === undefined ? {} : { component: toComponentView(component.children[0]) }),
	};
}

function unknownView(component: CanonicalComponent): UnknownComponentView {
	return {
		kind: 'unknown',
		path: component.path,
		raw: component.raw,
		...(component.id === undefined ? {} : { id: component.id }),
		...(component.discordType === undefined ? {} : { discordType: component.discordType }),
	};
}

function selectName(type: number | undefined): SelectView['type'] {
	if (type === COMPONENT.userSelect) return 'user';
	if (type === COMPONENT.roleSelect) return 'role';
	if (type === COMPONENT.mentionableSelect) return 'mentionable';
	if (type === COMPONENT.channelSelect) return 'channel';
	return 'string';
}

function componentScope(component: CanonicalComponent, label: string): Scope {
	return componentScopeFromParts(label, [], [], [component]);
}

function componentScopeFromParts(
	label: string,
	messages: readonly CanonicalMessage[],
	modals: readonly CanonicalModal[],
	components: readonly CanonicalComponent[],
): Scope {
	return { label, messages, modals, components };
}

function descendantContent(component: CanonicalComponent): CanonicalComponent[] {
	return descendantComponents(component, 'content');
}

function descendantComponents<K extends InternalKind>(component: CanonicalComponent, kind: K): CanonicalComponent[] {
	return flattenComponents([component]).filter(child => child !== component && child.kind === kind);
}

function summarizeMessage(message: CanonicalMessage): string {
	const attrs = [
		message.content === undefined ? undefined : `content=${JSON.stringify(message.content)}`,
		message.id === undefined ? undefined : `id=${JSON.stringify(message.id)}`,
		message.channelId === undefined ? undefined : `channelId=${JSON.stringify(message.channelId)}`,
		message.visibility === 'ephemeral' ? 'ephemeral=true' : undefined,
	].filter((attr): attr is string => attr !== undefined);
	return `${message.path}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
}

function summarizeModal(modal: CanonicalModal): string {
	const attrs = [
		modal.customId === undefined ? undefined : `#${modal.customId}`,
		modal.title === undefined ? undefined : `title=${JSON.stringify(modal.title)}`,
	].filter((attr): attr is string => attr !== undefined);
	return `${modal.path}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
}

function summarizeEmbed(embed: CanonicalEmbed): string {
	const attrs = [
		embed.view.title === undefined ? undefined : `title=${JSON.stringify(embed.view.title)}`,
		embed.view.description === undefined ? undefined : `description=${JSON.stringify(embed.view.description)}`,
	].filter((attr): attr is string => attr !== undefined);
	return `${embed.path}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
}

function summarizeComponent(component: CanonicalComponent): string {
	const attrs = [
		component.customId === undefined ? undefined : `#${component.customId}`,
		component.label === undefined ? undefined : `label=${JSON.stringify(component.label)}`,
		component.text === undefined ? undefined : `text=${JSON.stringify(component.text)}`,
		component.url === undefined ? undefined : `url=${JSON.stringify(component.url)}`,
		component.disabled ? 'disabled=true' : undefined,
	].filter((attr): attr is string => attr !== undefined);
	return `${component.path} ${component.kind}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
}

function summarizeDenial(denial: DenialView): string {
	const parts = [`denied ${denial.denialKind}`];
	if (denial.middleware) parts.push(`middleware=${denial.middleware}`);
	if (denial.missing.length > 0) parts.push(`missing=[${denial.missing.join(', ')}]`);
	return parts.join(' ');
}

function summarizeError(captured: CapturedErrorView): string {
	const error = captured.error;
	return `error ${error instanceof Error ? `${error.name}: ${error.message}` : errorText(error)}`;
}

function errorText(error: unknown): string {
	try {
		return String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}

function describeQuery(query: unknown): string {
	if (query === undefined) return '';
	// An error matcher is a bare function or RegExp, which JSON.stringify turns into `undefined` / `{}`.
	if (typeof query === 'function') return `[Function${query.name ? ` ${query.name}` : ''}]`;
	if (query instanceof RegExp) return String(query);
	return JSON.stringify(query, (_key, value) => (value instanceof RegExp ? value.toString() : value));
}

function plural(kind: string): string {
	if (kind === 'media') return 'media';
	return `${kind}s`;
}

/** A denial is not something the bot rendered, so the candidate heading does not claim it was. */
function recordedVerb(kind: string): string {
	return isDispatchKind(kind) ? 'recorded' : 'rendered';
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function debugOutput(
	canonical: {
		readonly messages: readonly CanonicalMessage[];
		readonly modals: readonly CanonicalModal[];
	},
	dispatch?: DispatchFacts,
): string {
	const lines = ['Rendered output:'];
	for (const message of canonical.messages) {
		lines.push(`  ${summarizeMessage(message)}`);
		for (const embed of message.embeds) lines.push(`    ${summarizeEmbed(embed)}`);
		for (const component of flattenComponents(message.components)) lines.push(`    ${summarizeComponent(component)}`);
	}
	for (const modal of canonical.modals) {
		lines.push(`  ${summarizeModal(modal)}`);
		for (const component of flattenComponents(modal.components)) lines.push(`    ${summarizeComponent(component)}`);
	}
	if (dispatch?.denial) lines.push(`  ${summarizeDenial(dispatch.denial)}`);
	if (dispatch?.error) lines.push(`  ${summarizeError(dispatch.error)}`);
	return lines.join('\n');
}
