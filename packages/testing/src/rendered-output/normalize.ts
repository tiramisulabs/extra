import { isEphemeral } from '../bot/message-flags';
import type { RecordedAction } from '../bot/rest';
import { arrayValue, asRecord, normalizeEmbed, numberValue, stringValue } from '../bot/state';
import type { MockContextResponse } from '../context';
import { renderedActionsOf } from './source';
import {
	type CanonicalComponent,
	type CanonicalMessage,
	type CanonicalModal,
	type CanonicalOutput,
	COMPONENT,
	type InternalKind,
	type RawView,
	type RenderedOptions,
	type RenderedSubject,
	SELECT_TYPES,
} from './types';

export function normalizeOutput(subject: RenderedSubject, options: RenderedOptions): CanonicalOutput {
	const renderedActions = renderedActionsOf(subject);
	if (renderedActions !== undefined) return fromActions(renderedActions, options);
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
	if (Array.isArray(record.messages)) return fromMessages(record.messages, options);
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

function fromMessages(messages: readonly unknown[], options: RenderedOptions): CanonicalOutput {
	const canonical = messages.map((message, index) =>
		normalizeMessage(message, {
			key: `message:${index}`,
			path: `message[${index}]`,
			transport: 'raw',
		}),
	);
	return { modals: [], messages: options.view === 'timeline' ? canonical : canonical };
}

function fromModals(modals: readonly unknown[]): CanonicalOutput {
	return {
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

	return { messages, modals };
}

function fromInteractionCallback(body: Record<string, unknown>, options: RenderedOptions): CanonicalOutput | undefined {
	const type = numberValue(body.type);
	if (type === undefined) return undefined;
	if (type === 9) return fromModals([asRecord(body.data)]);
	if (type !== 4 && type !== 7) return { messages: [], modals: [] };
	const message = normalizeMessage(asRecord(body.data), {
		key: 'callback:0',
		path: 'message[0]',
		transport: type === 7 ? 'update' : 'reply',
	});
	return { modals: [], messages: options.view === 'timeline' ? [message] : [message] };
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
