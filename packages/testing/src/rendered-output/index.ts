import type { OutgoingMessage } from '../bot/bot';
import { isEphemeral } from '../bot/message-flags';
import type { RecordedAction } from '../bot/rest';
import { arrayValue, asRecord, type EmbedView, normalizeEmbed, numberValue, stringValue } from '../bot/state';
import type { MockContextResponse } from '../context';

const COMPONENT = {
	actionRow: 1,
	button: 2,
	stringSelect: 3,
	textInput: 4,
	userSelect: 5,
	roleSelect: 6,
	mentionableSelect: 7,
	channelSelect: 8,
	section: 9,
	textDisplay: 10,
	thumbnail: 11,
	mediaGallery: 12,
	file: 13,
	separator: 14,
	container: 17,
	label: 18,
	fileUpload: 19,
} as const;

const SELECT_TYPES = new Set<number>([
	COMPONENT.stringSelect,
	COMPONENT.userSelect,
	COMPONENT.roleSelect,
	COMPONENT.mentionableSelect,
	COMPONENT.channelSelect,
]);

const STYLE_NAME: Record<string, number> = {
	primary: 1,
	secondary: 2,
	success: 3,
	danger: 4,
	link: 5,
};

const SELECT_NAME: Record<string, number> = {
	string: COMPONENT.stringSelect,
	user: COMPONENT.userSelect,
	role: COMPONENT.roleSelect,
	mentionable: COMPONENT.mentionableSelect,
	channel: COMPONENT.channelSelect,
};

type InternalKind = ComponentKind | 'actionRow' | 'file' | 'thumbnail' | 'unknown';

export type ReaderMode = 'get' | 'query' | 'all';

export type TextMatcher = string | RegExp | ((value: string) => boolean);

export interface RenderedOptions {
	/**
	 * `current` folds edits into their message when an id/token is available. `timeline` preserves every
	 * rendering event as a separate message.
	 */
	view?: 'current' | 'timeline';
}

export type RenderedSubject =
	| { readonly actions?: readonly RecordedAction[]; readonly messages?: readonly OutgoingMessage[] }
	| { readonly responses?: readonly MockContextResponse[] }
	| { readonly toJSON?: () => unknown }
	| readonly unknown[]
	| Record<string, unknown>
	| unknown;

export interface RawView<T = unknown> {
	readonly body: T;
	readonly path: string;
	readonly action?: RecordedAction;
}

export interface RawOutput {
	actions(): readonly RecordedAction[];
	messages(): readonly RawView[];
	modals(): readonly RawView[];
}

export interface RenderedNode {
	readonly kind: string;
	readonly path: string;
	readonly raw: RawView;
}

export interface RenderedMessageEvent {
	readonly path: string;
	readonly transport: CanonicalMessage['transport'];
	readonly raw: RawView;
}

export interface RenderedScope {
	readonly get: Finder<'get'>;
	readonly query: Finder<'query'>;
	readonly all: Finder<'all'>;
}

export interface RenderedOutput extends RenderedScope {
	readonly raw: RawOutput;
	debug(): string;
}

export interface RenderedMessage extends RenderedNode, RenderedScope {
	readonly kind: 'message';
	readonly id?: string;
	readonly channelId?: string;
	readonly transport: CanonicalMessage['transport'];
	readonly content?: string;
	readonly ephemeral: boolean;
	readonly flags?: number;
	readonly embeds: readonly EmbedView[];
	readonly components: readonly AnyComponentView[];
	readonly files: readonly unknown[];
	readonly history: readonly RenderedMessageEvent[];
}

export interface RenderedModal extends RenderedNode, RenderedScope {
	readonly kind: 'modal';
	readonly customId?: string;
	readonly title?: string;
	readonly components: readonly AnyComponentView[];
}

export interface ContentView extends RenderedNode {
	readonly kind: 'content';
	readonly id?: number;
	readonly text: string;
}

export interface ButtonView extends RenderedNode {
	readonly kind: 'button';
	readonly id?: number;
	readonly customId?: string;
	readonly label?: string;
	readonly disabled: boolean;
	readonly style?: number;
	readonly url?: string;
}

export interface SelectOptionView {
	readonly label?: string;
	readonly value?: string;
	readonly description?: string;
}

export interface SelectView extends RenderedNode {
	readonly kind: 'select';
	readonly id?: number;
	readonly customId?: string;
	readonly label?: string;
	readonly description?: string;
	readonly placeholder?: string;
	readonly disabled: boolean;
	readonly type: 'string' | 'user' | 'role' | 'mentionable' | 'channel';
	readonly options: readonly SelectOptionView[];
}

export interface TextInputView extends RenderedNode {
	readonly kind: 'input';
	readonly id?: number;
	readonly customId?: string;
	readonly label?: string;
	readonly description?: string;
	readonly required: boolean;
	readonly value?: string;
	readonly style?: number;
}

export interface FileUploadView extends RenderedNode {
	readonly kind: 'fileUpload';
	readonly id?: number;
	readonly customId?: string;
	readonly label?: string;
	readonly description?: string;
	readonly required: boolean;
}

export interface ContainerView extends RenderedNode {
	readonly kind: 'container';
	readonly id?: number;
	readonly accentColor?: number;
	readonly content: readonly ContentView[];
	readonly sections: readonly SectionView[];
	readonly media: readonly MediaView[];
	readonly components: readonly AnyComponentView[];
	readonly get: ContainerFinder<'get'>;
	readonly query: ContainerFinder<'query'>;
	readonly all: ContainerFinder<'all'>;
}

export interface SectionView extends RenderedNode {
	readonly kind: 'section';
	readonly id?: number;
	readonly content: readonly ContentView[];
	readonly media: readonly MediaView[];
	readonly components: readonly AnyComponentView[];
	readonly get: ContainerFinder<'get'>;
	readonly query: ContainerFinder<'query'>;
	readonly all: ContainerFinder<'all'>;
	accessory(): AccessoryScope;
}

export interface AccessoryScope extends RenderedScope {
	readonly raw: RawView;
}

export interface MediaView extends RenderedNode {
	readonly kind: 'media';
	readonly id?: number;
	readonly url?: string;
	readonly contentType?: string;
	readonly filename?: string;
	readonly description?: string;
}

export interface SeparatorView extends RenderedNode {
	readonly kind: 'separator';
	readonly id?: number;
	readonly divider?: boolean;
	readonly spacing?: number;
}

export interface LabelView extends RenderedNode {
	readonly kind: 'label';
	readonly id?: number;
	readonly label?: string;
	readonly description?: string;
	readonly component?: AnyComponentView;
}

export interface UnknownComponentView extends RenderedNode {
	readonly kind: 'unknown';
	readonly id?: number;
	readonly discordType?: number;
}

export type AnyComponentView =
	| ButtonView
	| SelectView
	| TextInputView
	| FileUploadView
	| ContainerView
	| ContentView
	| SectionView
	| MediaView
	| SeparatorView
	| LabelView
	| UnknownComponentView;

type Result<Mode extends ReaderMode, View> = Mode extends 'get'
	? View
	: Mode extends 'query'
		? View | undefined
		: readonly View[];

export interface Finder<Mode extends ReaderMode> {
	message(query?: RenderedMessageQuery): Result<Mode, RenderedMessage>;
	modal(query?: ModalQuery | string): Result<Mode, RenderedModal>;
	embed(query?: EmbedQuery): Result<Mode, EmbedView>;
	button(query?: ButtonQuery | string): Result<Mode, ButtonView>;
	select(query?: SelectQuery | string): Result<Mode, SelectView>;
	input(query?: InputQuery | string): Result<Mode, TextInputView>;
	container(query?: ContainerQuery): Result<Mode, ContainerView>;
	component<K extends ComponentKind>(kind: K, query?: ComponentQueryArg<K>): Result<Mode, ComponentView<K>>;
}

export interface ContainerFinder<Mode extends ReaderMode> extends Finder<Mode> {
	content(query?: ContentQuery): Result<Mode, ContentView>;
	section(query?: SectionQuery): Result<Mode, SectionView>;
	media(query?: MediaQuery): Result<Mode, MediaView>;
}

export interface RenderedMessageQuery {
	id?: TextMatcher;
	channelId?: TextMatcher;
	content?: TextMatcher;
	ephemeral?: boolean;
	transport?: 'reply' | 'update' | 'edit' | 'followup' | 'channelMessage' | 'builder' | 'raw';
}

export interface ModalQuery {
	customId?: TextMatcher;
	title?: TextMatcher;
}

export interface EmbedQuery {
	title?: TextMatcher;
	description?: TextMatcher;
	contains?: TextMatcher;
	author?: TextMatcher;
	footer?: TextMatcher;
	color?: number;
	field?: FieldQuery | readonly FieldQuery[];
}

export interface FieldQuery {
	name?: TextMatcher;
	value?: TextMatcher;
	inline?: boolean;
}

export interface ButtonQuery {
	customId?: TextMatcher;
	label?: TextMatcher;
	disabled?: boolean;
	style?: 'primary' | 'secondary' | 'success' | 'danger' | 'link' | number;
	url?: TextMatcher;
}

export interface SelectQuery {
	customId?: TextMatcher;
	label?: TextMatcher;
	placeholder?: TextMatcher;
	disabled?: boolean;
	type?: 'string' | 'user' | 'role' | 'mentionable' | 'channel';
	option?: SelectOptionQuery | readonly SelectOptionQuery[];
}

export interface SelectOptionQuery {
	label?: TextMatcher;
	value?: TextMatcher;
	description?: TextMatcher;
}

export interface InputQuery {
	customId?: TextMatcher;
	label?: TextMatcher;
	required?: boolean;
	value?: TextMatcher;
	style?: number;
}

export interface ContainerQuery {
	id?: number;
	accentColor?: number;
	content?: TextMatcher;
	has?: ComponentRef | readonly ComponentRef[];
}

export interface ContentQuery {
	text?: TextMatcher;
}

export interface SectionQuery {
	content?: TextMatcher;
	accessory?: ComponentRef;
}

export interface MediaQuery {
	url?: TextMatcher;
	contentType?: TextMatcher;
	filename?: TextMatcher;
}

export interface SeparatorQuery {
	divider?: boolean;
	spacing?: number;
}

export interface LabelQuery {
	label?: TextMatcher;
	description?: TextMatcher;
}

export interface FileUploadQuery {
	customId?: TextMatcher;
	label?: TextMatcher;
	required?: boolean;
}

export type ComponentRef =
	| { kind: 'button'; query?: ButtonQuery | string }
	| { kind: 'select'; query?: SelectQuery | string }
	| { kind: 'input'; query?: InputQuery | string }
	| { kind: 'content'; query?: ContentQuery }
	| { kind: 'section'; query?: SectionQuery }
	| { kind: 'media'; query?: MediaQuery };

export interface ComponentKindMap {
	button: { view: ButtonView; query: ButtonQuery; shorthand: string };
	select: { view: SelectView; query: SelectQuery; shorthand: string };
	input: { view: TextInputView; query: InputQuery; shorthand: string };
	container: { view: ContainerView; query: ContainerQuery };
	content: { view: ContentView; query: ContentQuery };
	section: { view: SectionView; query: SectionQuery };
	media: { view: MediaView; query: MediaQuery };
	separator: { view: SeparatorView; query: SeparatorQuery };
	label: { view: LabelView; query: LabelQuery };
	fileUpload: { view: FileUploadView; query: FileUploadQuery; shorthand: string };
}

export type ComponentKind = keyof ComponentKindMap;
export type ComponentView<K extends ComponentKind> = ComponentKindMap[K]['view'];
export type ComponentQuery<K extends ComponentKind> = ComponentKindMap[K]['query'];
type ComponentQueryArg<K extends ComponentKind> = ComponentKindMap[K] extends { shorthand: string }
	? ComponentQuery<K> | string
	: ComponentQuery<K>;

interface CanonicalEmbed {
	view: EmbedView;
	raw: RawView;
	path: string;
}

interface CanonicalComponent {
	kind: InternalKind;
	discordType?: number;
	id?: number;
	customId?: string;
	label?: string;
	description?: string;
	text?: string;
	disabled?: boolean;
	style?: number;
	url?: string;
	contentType?: string;
	filename?: string;
	placeholder?: string;
	required?: boolean;
	value?: string;
	options: SelectOptionView[];
	children: CanonicalComponent[];
	accessory?: CanonicalComponent;
	raw: RawView;
	path: string;
}

interface CanonicalMessage {
	key: string;
	id?: string;
	channelId?: string;
	transport: 'reply' | 'update' | 'edit' | 'followup' | 'channelMessage' | 'builder' | 'raw';
	visibility: 'public' | 'ephemeral' | 'unknown';
	flags?: number;
	content?: string;
	embeds: CanonicalEmbed[];
	components: CanonicalComponent[];
	files: unknown[];
	raw: RawView;
	path: string;
	history: RenderedMessageEvent[];
}

interface CanonicalModal {
	index: number;
	customId?: string;
	title?: string;
	components: CanonicalComponent[];
	raw: RawView;
	path: string;
}

interface CanonicalOutput {
	messages: CanonicalMessage[];
	modals: CanonicalModal[];
	actions: readonly RecordedAction[];
}

interface Scope {
	label: string;
	messages: readonly CanonicalMessage[];
	modals: readonly CanonicalModal[];
	components: readonly CanonicalComponent[];
}

interface Candidate<T> {
	value: T;
	path: string;
	summary: string;
}

export class RenderedOutputError extends Error {
	constructor(
		message: string,
		readonly details: {
			readonly mode: 'get';
			readonly kind: string;
			readonly query: unknown;
			readonly scope: string;
			readonly matches: readonly string[];
			readonly candidates: readonly string[];
		},
	) {
		super(message);
		this.name = 'RenderedOutputError';
	}
}

export function rendered(subject: RenderedSubject, options: RenderedOptions = {}): RenderedOutput {
	const canonical = normalizeOutput(subject, options);
	const scope: Scope = {
		label: 'rendered',
		messages: canonical.messages,
		modals: canonical.modals,
		components: [
			...canonical.messages.flatMap(message => message.components),
			...canonical.modals.flatMap(modal => modal.components),
		],
	};
	return {
		raw: {
			actions: () => canonical.actions,
			messages: () => canonical.messages.map(message => message.raw),
			modals: () => canonical.modals.map(modal => modal.raw),
		},
		get: makeFinder('get', scope),
		query: makeFinder('query', scope),
		all: makeFinder('all', scope),
		debug: () => debugOutput(canonical),
	};
}

function normalizeOutput(subject: RenderedSubject, options: RenderedOptions): CanonicalOutput {
	const source = unwrapBuilder(subject);
	const dispatchActions = dispatchActionsOf(source);
	if (dispatchActions) return fromActions(dispatchActions.actions, options, dispatchActions.dispatchId);
	const record = asRecord(source);
	if (Array.isArray(record.actions)) return fromActions(record.actions as RecordedAction[], options);
	const callback = fromInteractionCallback(record, options);
	if (callback) return callback;
	const capturedBody = asRecord(record.body);
	const capturedCallback = fromInteractionCallback(capturedBody, options);
	if (capturedCallback) return capturedCallback;
	if (Array.isArray(record.responses)) return fromResponses(record.responses as MockContextResponse[]);
	if (Array.isArray(record.messages))
		return fromMessages(record.messages, options, record.actions as RecordedAction[] | undefined);
	if (isMessageViewLike(record)) return fromMessages([record], options);
	if (isModalPayload(record)) return fromModals([record]);
	if (Array.isArray(source)) return fromMessages(source, options);
	return fromMessages([source], options);
}

function dispatchActionsOf(subject: unknown): { actions: readonly RecordedAction[]; dispatchId?: number } | undefined {
	const record = asRecord(subject);
	const rest = asRecord(record.rest);
	const actions = rest.actions;
	if (!Array.isArray(actions)) return undefined;
	return {
		actions: actions as RecordedAction[],
		...(typeof record.dispatchId === 'number' ? { dispatchId: record.dispatchId } : {}),
	};
}

function fromResponses(responses: readonly MockContextResponse[]): CanonicalOutput {
	return {
		actions: [],
		modals: [],
		messages: responses.map((response, index) =>
			normalizeMessage(response, {
				key: `response:${index}`,
				path: `message[${index}]`,
				transport: 'raw',
			}),
		),
	};
}

function fromMessages(
	messages: readonly unknown[],
	options: RenderedOptions,
	actions: readonly RecordedAction[] = [],
): CanonicalOutput {
	const canonical = messages.map((message, index) =>
		normalizeMessage(message, {
			key: `message:${index}`,
			path: `message[${index}]`,
			transport: 'raw',
		}),
	);
	return { actions, modals: [], messages: options.view === 'timeline' ? canonical : canonical };
}

function fromModals(modals: readonly unknown[]): CanonicalOutput {
	return {
		actions: [],
		messages: [],
		modals: modals.map((modal, index) => normalizeModal(modal, index, `modal[${index}]`)),
	};
}

function fromActions(
	actions: readonly RecordedAction[],
	options: RenderedOptions,
	dispatchId?: number,
): CanonicalOutput {
	const messages: CanonicalMessage[] = [];
	const modals: CanonicalModal[] = [];
	const byKey = new Map<string, number>();
	const relevant = dispatchId === undefined ? actions : actions.filter(action => action.dispatchId === dispatchId);

	for (const action of relevant) {
		const rendered = renderedFromAction(action);
		if (!rendered) continue;
		if (rendered.modal) {
			modals.push(normalizeModal(rendered.modal, modals.length, `modal[${modals.length}]`, action));
			continue;
		}
		if (!rendered.message) continue;
		const path = `message[${options.view === 'timeline' ? messages.length : (byKey.get(rendered.key) ?? messages.length)}]`;
		const next = normalizeMessage(rendered.message, {
			key: rendered.key,
			path,
			transport: rendered.transport,
			action,
			id: rendered.id,
			channelId: rendered.channelId,
		});
		if (options.view === 'timeline') {
			messages.push(next);
			continue;
		}
		const existingIndex = byKey.get(rendered.key);
		if (existingIndex === undefined) {
			byKey.set(rendered.key, messages.length);
			messages.push(next);
			continue;
		}
		messages[existingIndex] = mergeMessage(messages[existingIndex], next);
	}

	return { actions: relevant, messages, modals };
}

function fromInteractionCallback(body: Record<string, unknown>, options: RenderedOptions): CanonicalOutput | undefined {
	const type = numberValue(body.type);
	if (type === undefined) return undefined;
	if (type === 9) return fromModals([asRecord(body.data)]);
	if (type !== 4 && type !== 7) return { actions: [], messages: [], modals: [] };
	const message = normalizeMessage(asRecord(body.data), {
		key: 'callback:0',
		path: 'message[0]',
		transport: type === 7 ? 'update' : 'reply',
	});
	return { actions: [], modals: [], messages: options.view === 'timeline' ? [message] : [message] };
}

function renderedFromAction(action: RecordedAction):
	| {
			key: string;
			transport: CanonicalMessage['transport'];
			message?: unknown;
			modal?: unknown;
			id?: string;
			channelId?: string;
	  }
	| undefined {
	const body = asRecord(action.body);
	const type = numberValue(body.type);
	if (type !== undefined) {
		const data = asRecord(body.data);
		if (type === 9) {
			return { key: `modal:${action.seq}`, transport: 'reply', modal: data };
		}
		if (type === 4 || type === 7) {
			const token = interactionCallbackToken(action.route);
			const response = asRecord(action.response);
			return {
				key: token ? `token:${token}:original` : response.id ? `message:${response.id}` : `action:${action.seq}`,
				transport: type === 7 ? 'update' : 'reply',
				message: data,
				...(stringValue(response.id) === undefined ? {} : { id: stringValue(response.id) }),
				...(stringValue(response.channel_id) === undefined ? {} : { channelId: stringValue(response.channel_id) }),
			};
		}
		return undefined;
	}
	if (!looksLikeMessageBody(body)) return undefined;
	const response = asRecord(action.response);
	const routeMessageId = messageIdFromRoute(action.route);
	const token = webhookToken(action.route);
	const isEdit = action.method === 'PATCH';
	const key = stringValue(response.id)
		? `message:${stringValue(response.id)}`
		: routeMessageId
			? `message:${routeMessageId}`
			: isEdit && token
				? `token:${token}:original`
				: `action:${action.seq}`;
	return {
		key,
		transport: transportFromAction(action),
		message: body,
		...(stringValue(response.id) === undefined ? {} : { id: stringValue(response.id) }),
		...(stringValue(response.channel_id) === undefined ? {} : { channelId: stringValue(response.channel_id) }),
	};
}

function looksLikeMessageBody(body: Record<string, unknown>): boolean {
	return (
		body.content !== undefined ||
		body.embeds !== undefined ||
		body.components !== undefined ||
		body.files !== undefined ||
		body.flags !== undefined ||
		body.attachments !== undefined
	);
}

function interactionCallbackToken(route: string): string | undefined {
	return /^\/interactions\/[^/]+\/([^/]+)\/callback$/.exec(route)?.[1];
}

function webhookToken(route: string): string | undefined {
	return /^\/webhooks\/[^/]+\/([^/]+)/.exec(route)?.[1];
}

function messageIdFromRoute(route: string): string | undefined {
	const match = /\/messages\/([^/?]+)(?:\?|$)/.exec(route);
	if (!match || match[1] === '@original') return undefined;
	return decodeURIComponent(match[1]);
}

function transportFromAction(action: RecordedAction): CanonicalMessage['transport'] {
	if (action.method === 'PATCH') return 'edit';
	if (/^\/channels\/[^/]+\/messages/.test(action.route)) return 'channelMessage';
	if (/^\/webhooks\/[^/]+\/[^/]+$/.test(action.route)) return 'followup';
	return 'raw';
}

function normalizeMessage(
	value: unknown,
	init: {
		key: string;
		path: string;
		transport: CanonicalMessage['transport'];
		action?: RecordedAction;
		id?: string;
		channelId?: string;
	},
): CanonicalMessage {
	const body = unwrapBuilder(value);
	const record = typeof body === 'string' ? { content: body } : asRecord(body);
	const raw = rawView(record, init.path, init.action);
	const flags = numberValue(record.flags);
	const components = normalizeComponents(record.components, `${init.path} > components`, raw);
	const embeds = arrayValue(record.embeds).map((embed, index) => ({
		view: normalizeEmbed(embed),
		raw: rawView(unwrapBuilder(embed), `${init.path} > embed[${index}]`, init.action),
		path: `${init.path} > embed[${index}]`,
	}));
	const files =
		record.files !== undefined
			? arrayValue(record.files)
			: record.attachments !== undefined
				? arrayValue(record.attachments)
				: (init.action?.files ?? []);
	const id = init.id ?? stringValue(record.id);
	const channelId = init.channelId ?? stringValue(record.channel_id) ?? stringValue(record.channelId);
	return {
		key: init.key,
		...(id === undefined ? {} : { id }),
		...(channelId === undefined ? {} : { channelId }),
		transport: init.transport,
		visibility: flags === undefined ? 'unknown' : isEphemeral({ flags }) ? 'ephemeral' : 'public',
		...(flags === undefined ? {} : { flags }),
		...(stringValue(record.content) === undefined ? {} : { content: stringValue(record.content) }),
		embeds,
		components,
		files,
		raw,
		path: init.path,
		history: [{ path: init.path, transport: init.transport, raw }],
	};
}

function mergeMessage(previous: CanonicalMessage, next: CanonicalMessage): CanonicalMessage {
	const content = hasKey(next.raw.body, 'content') ? next.content : previous.content;
	const id = next.id ?? previous.id;
	const channelId = next.channelId ?? previous.channelId;
	const flags = next.flags ?? previous.flags;
	return {
		key: previous.key,
		...(id === undefined ? {} : { id }),
		...(channelId === undefined ? {} : { channelId }),
		transport: next.transport,
		visibility: next.visibility === 'unknown' ? previous.visibility : next.visibility,
		...(flags === undefined ? {} : { flags }),
		...(content === undefined ? {} : { content }),
		embeds: next.embeds.length > 0 || hasKey(next.raw.body, 'embeds') ? next.embeds : previous.embeds,
		components: hasKey(next.raw.body, 'components') ? next.components : previous.components,
		files:
			next.files.length > 0 || hasKey(next.raw.body, 'files') || hasKey(next.raw.body, 'attachments')
				? next.files
				: previous.files,
		raw: next.raw,
		path: previous.path,
		history: [...previous.history, ...next.history],
	};
}

function hasKey(value: unknown, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(asRecord(value), key);
}

function normalizeModal(value: unknown, index: number, path: string, action?: RecordedAction): CanonicalModal {
	const body = unwrapBuilder(value);
	const record = asRecord(body);
	const raw = rawView(record, path, action);
	return {
		index,
		...(stringValue(record.custom_id) === undefined ? {} : { customId: stringValue(record.custom_id) }),
		...(stringValue(record.customId) === undefined ? {} : { customId: stringValue(record.customId) }),
		...(stringValue(record.title) === undefined ? {} : { title: stringValue(record.title) }),
		components: normalizeComponents(record.components, `${path} > components`, raw),
		raw,
		path,
	};
}

function normalizeComponents(value: unknown, path: string, parentRaw: RawView): CanonicalComponent[] {
	return arrayValue(unwrapBuilder(value)).map((component, index) =>
		normalizeComponent(component, `${path}[${index}]`, parentRaw),
	);
}

function normalizeComponent(
	value: unknown,
	path: string,
	parentRaw: RawView,
	labelContext: { label?: string; description?: string } = {},
): CanonicalComponent {
	const body = unwrapBuilder(value);
	const record = asRecord(body);
	const type = numberValue(record.type);
	const raw = rawView(record, path, parentRaw.action);
	const kind = componentKind(type);
	const options = arrayValue(record.options).map(option => {
		const rawOption = asRecord(option);
		return {
			...(stringValue(rawOption.label) === undefined ? {} : { label: stringValue(rawOption.label) }),
			...(stringValue(rawOption.value) === undefined ? {} : { value: stringValue(rawOption.value) }),
			...(stringValue(rawOption.description) === undefined ? {} : { description: stringValue(rawOption.description) }),
		};
	});
	const label = stringValue(record.label) ?? labelContext.label;
	const description = stringValue(record.description) ?? labelContext.description;
	const base: CanonicalComponent = {
		kind,
		...(type === undefined ? {} : { discordType: type }),
		...(numberValue(record.id) === undefined ? {} : { id: numberValue(record.id) }),
		...(stringValue(record.custom_id) === undefined ? {} : { customId: stringValue(record.custom_id) }),
		...(stringValue(record.customId) === undefined ? {} : { customId: stringValue(record.customId) }),
		...(label === undefined ? {} : { label }),
		...(description === undefined ? {} : { description }),
		...(typeof record.content === 'string' ? { text: record.content } : {}),
		...(typeof record.disabled === 'boolean' ? { disabled: record.disabled } : {}),
		...(numberValue(record.style) === undefined ? {} : { style: numberValue(record.style) }),
		...(stringValue(record.url) === undefined ? {} : { url: stringValue(record.url) }),
		...(stringValue(record.placeholder) === undefined ? {} : { placeholder: stringValue(record.placeholder) }),
		...(typeof record.required === 'boolean' ? { required: record.required } : {}),
		...(stringValue(record.value) === undefined ? {} : { value: stringValue(record.value) }),
		...mediaFields(record),
		options,
		children: [],
		raw,
		path,
	};

	if (kind === 'label') {
		const labelChild = record.component
			? normalizeComponent(record.component, `${path} > component`, parentRaw, {
					label: base.label,
					description: base.description,
				})
			: undefined;
		return { ...base, children: labelChild ? [labelChild] : [] };
	}

	const children = normalizeComponents(record.components, `${path} > components`, parentRaw);
	const accessory =
		record.accessory === undefined ? undefined : normalizeComponent(record.accessory, `${path} > accessory`, parentRaw);
	if (type === COMPONENT.mediaGallery) {
		const items = arrayValue(record.items).map((item, index) =>
			normalizeMediaItem(item, `${path} > item[${index}]`, parentRaw),
		);
		return { ...base, children: [...children, ...items] };
	}
	return { ...base, children, ...(accessory === undefined ? {} : { accessory }) };
}

function normalizeMediaItem(value: unknown, path: string, parentRaw: RawView): CanonicalComponent {
	const item = asRecord(unwrapBuilder(value));
	const media = asRecord(item.media);
	const raw = rawView(item, path, parentRaw.action);
	return {
		kind: 'media',
		discordType: COMPONENT.mediaGallery,
		...(stringValue(media.url) === undefined ? {} : { url: stringValue(media.url) }),
		...(stringValue(media.content_type) === undefined ? {} : { contentType: stringValue(media.content_type) }),
		...(filenameFromUrl(stringValue(media.url)) === undefined
			? {}
			: { filename: filenameFromUrl(stringValue(media.url)) }),
		...(stringValue(item.description) === undefined ? {} : { description: stringValue(item.description) }),
		options: [],
		children: [],
		raw,
		path,
	};
}

function mediaFields(record: Record<string, unknown>): Partial<CanonicalComponent> {
	const media = asRecord(record.media);
	const file = asRecord(record.file);
	const source = media.url !== undefined ? media : file.url !== undefined ? file : record;
	const url = stringValue(source.url);
	const contentType = stringValue(source.content_type);
	const filename = filenameFromUrl(url);
	return {
		...(url === undefined ? {} : { url }),
		...(contentType === undefined ? {} : { contentType }),
		...(filename === undefined ? {} : { filename }),
	};
}

function filenameFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return url.startsWith('attachment://') ? url.slice('attachment://'.length) : url.split('/').at(-1);
}

function componentKind(type: number | undefined): InternalKind {
	if (type === COMPONENT.actionRow) return 'actionRow';
	if (type === COMPONENT.button) return 'button';
	if (type !== undefined && SELECT_TYPES.has(type)) return 'select';
	if (type === COMPONENT.textInput) return 'input';
	if (type === COMPONENT.fileUpload) return 'fileUpload';
	if (type === COMPONENT.container) return 'container';
	if (type === COMPONENT.textDisplay) return 'content';
	if (type === COMPONENT.section) return 'section';
	if (type === COMPONENT.mediaGallery) return 'unknown';
	if (type === COMPONENT.file) return 'media';
	if (type === COMPONENT.thumbnail) return 'media';
	if (type === COMPONENT.separator) return 'separator';
	if (type === COMPONENT.label) return 'label';
	return 'unknown';
}

function rawView<T>(body: T, path: string, action?: RecordedAction): RawView<T> {
	return { body, path, ...(action === undefined ? {} : { action }) };
}

function unwrapBuilder(value: unknown): unknown {
	if (value && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return (value as { toJSON(): unknown }).toJSON();
	}
	return value;
}

function isModalPayload(record: Record<string, unknown>): boolean {
	return (
		(record.custom_id !== undefined || record.customId !== undefined || record.title !== undefined) &&
		Array.isArray(record.components) &&
		record.content === undefined &&
		record.embeds === undefined
	);
}

function isMessageViewLike(record: Record<string, unknown>): boolean {
	return typeof record.id === 'string' && typeof record.channelId === 'string' && Array.isArray(record.components);
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
	if (mode === 'query') return (candidates[0] ? toView(candidates[0].value) : undefined) as Result<Mode, View>;
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
	const nearMisses =
		matches.length === 0 && renderedCandidates.length > 0
			? renderedCandidates.slice(0, 5).map(candidate => candidate.replace(/^  /, '  '))
			: [];
	const queryText = describeQuery(query);
	const base =
		matches.length === 0
			? `${scope.label}.get.${kind}(${queryText}) found 0 ${plural(kind)}.`
			: `${scope.label}.get.${kind}(${queryText}) found ${matches.length} ${plural(kind)}; get.${kind} requires exactly one.`;
	const sections = [
		base,
		matches.length > 1 ? '\nMatches:\n' + renderedMatches.join('\n') : undefined,
		matches.length === 0 && renderedCandidates.length
			? `\n${capitalize(plural(kind))} rendered:\n${renderedCandidates.join('\n')}`
			: undefined,
		nearMisses.length > 0 ? `\nNear misses:\n${nearMisses.join('\n')}` : undefined,
		containerContentDiagnostics(kind, query, scope),
		modalFieldDiagnostics(kind, scope),
		kind !== 'message' && scope.messages.length > 1
			? `\nUse a scope first, for example rendered(result).get.message({ content: /.../ }).get.${kind}(...).`
			: undefined,
		kind !== 'container'
			? `\nFor Components V2 panels, try rendered(result).get.container({ content: /.../ }).get.${kind}(...).`
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

function containerContentDiagnostics(kind: string, query: unknown, scope: Scope): string | undefined {
	if (kind !== 'message' || !query || typeof query !== 'object' || Array.isArray(query)) return undefined;
	const content = (query as { content?: unknown }).content;
	if (content === undefined) return undefined;
	const matches = componentCandidates(scope, 'content', { text: content as TextMatcher });
	if (matches.length === 0) return undefined;
	return `\nContainer content matched:\n${matches.map(match => `  ${match.summary}`).join('\n')}\n\nIf the Components V2 panel is the contract, use:\n  rendered(result).get.container({ content: ${describeQuery(content)} })`;
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

function candidatesForKind(scope: Scope, kind: string): Candidate<unknown>[] {
	if (kind === 'message') return messageCandidates(scope, undefined);
	if (kind === 'modal') return modalCandidates(scope, undefined);
	if (kind === 'embed') return embedCandidates(scope, undefined);
	if (isComponentKind(kind)) return componentCandidates(scope, kind, undefined);
	return [];
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

function describeQuery(query: unknown): string {
	if (query === undefined) return '';
	return JSON.stringify(query, (_key, value) => (value instanceof RegExp ? value.toString() : value));
}

function plural(kind: string): string {
	if (kind === 'media') return 'media';
	return `${kind}s`;
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function debugOutput(canonical: CanonicalOutput): string {
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
	return lines.join('\n');
}
