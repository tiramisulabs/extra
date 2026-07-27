import type { DispatchDenial } from '../bot/dispatch-context';
import type { RecordedAction } from '../bot/rest';
import type { EmbedView } from '../bot/state';

export const COMPONENT = {
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

export const SELECT_TYPES = new Set<number>([
	COMPONENT.stringSelect,
	COMPONENT.userSelect,
	COMPONENT.roleSelect,
	COMPONENT.mentionableSelect,
	COMPONENT.channelSelect,
]);

export const STYLE_NAME: Record<string, number> = {
	primary: 1,
	secondary: 2,
	success: 3,
	danger: 4,
	link: 5,
};

export const SELECT_NAME: Record<string, number> = {
	string: COMPONENT.stringSelect,
	user: COMPONENT.userSelect,
	role: COMPONENT.roleSelect,
	mentionable: COMPONENT.mentionableSelect,
	channel: COMPONENT.channelSelect,
};

export type InternalKind = ComponentKind | 'actionRow' | 'file' | 'thumbnail' | 'unknown';

export type ReaderMode = 'get' | 'query' | 'all';

export type TextMatcher = string | RegExp | ((value: string) => boolean);

export interface RenderedOptions {
	/**
	 * `current` folds edits into their message when an id/token is available. `timeline` preserves every
	 * rendering event as a separate message.
	 */
	view?: 'current' | 'timeline';
}

/**
 * Anything {@link rendered} can read: a `MockBot`, an `Actor`, a `DispatchResult`, a parked flow, any mock
 * context, an interaction-callback body, a raw message payload (or an array of them), or a Seyfert builder.
 *
 * Deliberately `object` and not a union of those shapes. Several are classes and the rest overlap
 * structurally, so a union that admits all of them has to end in `| unknown` — and `X | unknown` *is*
 * `unknown`, which accepts `42`, `null` and an un-awaited promise while looking like it documents
 * something. `object` buys the one guarantee a union can here (no primitives, no `null`); `rendered()`
 * names the remaining mistakes at runtime, where it can say which one you made.
 */
export type RenderedSubject = object;

export interface RawView<T = unknown> {
	readonly body: T;
	readonly path: string;
	readonly action?: RecordedAction;
}

export interface RawOutput {
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

export interface RenderedOutput {
	readonly raw: RawOutput;
	readonly get: OutputFinder<'get'>;
	readonly query: OutputFinder<'query'>;
	readonly all: OutputFinder<'all'>;
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

export type Result<Mode extends ReaderMode, View> = Mode extends 'get'
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

/**
 * What the top-level {@link rendered} reader can find, on top of every {@link Finder} kind.
 *
 * A denial and a captured error belong to the dispatch, not to a message or a container, so they are not on
 * the scoped finders that `get.message(...)` and `get.container(...)` hand back.
 */
export interface OutputFinder<Mode extends ReaderMode> extends Finder<Mode> {
	denial(query?: DenialQuery): Result<Mode, DenialView>;
	// Two signatures, not one union parameter: a union would put `String.prototype.match` in the contextual type
	// of `{ match: error => ... }` and leave the callback's parameter implicitly `any`.
	error(query?: ErrorQuery): Result<Mode, CapturedErrorView>;
	error(matcher: ErrorMatcher): Result<Mode, CapturedErrorView>;
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

export interface DenialQuery {
	kind?: DispatchDenial['kind'];
	middleware?: string;
	missing?: string | readonly string[];
}

/** Matched against the captured error's `String(error)` when a string or a RegExp; called with it when a function. */
export type ErrorMatcher = string | RegExp | ((error: unknown) => boolean);

export interface ErrorQuery {
	match?: ErrorMatcher;
}

/** A dispatch that never reached the command body, in the same shape as every other reader view. */
export interface DenialView {
	readonly kind: 'denial';
	/** `stop` / `no-next` / `permissions` / `bot-permissions`; named `denialKind` so `kind` stays the view tag. */
	readonly denialKind: DispatchDenial['kind'];
	readonly reason?: unknown;
	readonly middleware?: string;
	readonly missing: readonly string[];
	readonly raw: DispatchDenial;
}

/** An unhandled error the dispatch captured under `createMockBot({ onCommandError: 'capture' })`. */
export interface CapturedErrorView {
	readonly kind: 'error';
	readonly error: unknown;
}

/**
 * The dispatch-level facts of a subject. Absent - not empty - for a subject that is not a `DispatchResult`, so
 * `get.denial()` on a bot or a raw payload can say the subject cannot be denied instead of finding nothing.
 */
export interface DispatchFacts {
	readonly denial?: DenialView;
	readonly error?: CapturedErrorView;
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
export type ComponentQueryArg<K extends ComponentKind> = ComponentKindMap[K] extends { shorthand: string }
	? ComponentQuery<K> | string
	: ComponentQuery<K>;

export interface CanonicalEmbed {
	view: EmbedView;
	raw: RawView;
	path: string;
}

export interface CanonicalComponent {
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

export interface CanonicalMessage {
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

export interface CanonicalModal {
	index: number;
	customId?: string;
	title?: string;
	components: CanonicalComponent[];
	raw: RawView;
	path: string;
}

export interface CanonicalOutput {
	messages: CanonicalMessage[];
	modals: CanonicalModal[];
}

export interface Scope {
	label: string;
	messages: readonly CanonicalMessage[];
	modals: readonly CanonicalModal[];
	components: readonly CanonicalComponent[];
	dispatch?: DispatchFacts;
}

export interface Candidate<T> {
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
