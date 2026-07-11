import { mockId, mockTimestamp } from '../id';
import { type ApiAttachment, type ApiPoll, apiAttachment, apiPoll, type ThreadMetadata } from './payloads';
import type { ChannelOverwriteLike } from './permissions';
import { type RecordedAction } from './rest';
import type { EmbedView, EntityDiff, InteractiveComponentView, RoleView, WorldStateCandidate } from './state-contracts';
import type { MockWorld } from './world';

export class WorldStateError extends Error {
	readonly name = 'WorldStateError';

	constructor(
		readonly entity: string,
		readonly query: Record<string, unknown>,
		readonly matches: WorldStateCandidate[],
		readonly candidates: WorldStateCandidate[],
	) {
		const shown = matches.length > 0 ? matches : candidates;
		const suffix = shown.length ? ` Candidates: ${shown.slice(0, 8).map(formatCandidate).join(', ')}.` : '';
		super(`Expected exactly one world ${entity} matching ${formatQuery(query)}, found ${matches.length}.${suffix}`);
	}
}

export function queryMatches<T extends Record<string, unknown>>(fields: T, query: Partial<T> | undefined): boolean {
	if (!query) return true;
	for (const [key, expected] of Object.entries(query)) {
		if (expected === undefined) continue;
		if (fields[key] !== expected) return false;
	}
	return true;
}

export function formatQuery(query: Record<string, unknown>): string {
	const entries = Object.entries(query).filter(([, value]) => value !== undefined);
	if (!entries.length) return '{}';
	return `{ ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')} }`;
}

export function formatCandidate(candidate: WorldStateCandidate): string {
	return candidate.summary ? `${candidate.path} (${candidate.summary})` : candidate.path;
}

export const EMPTY_WORLD = (): MockWorld => ({
	guilds: [],
	channels: [],
	users: [],
	members: [],
	roles: [],
	messages: [],
});

export function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** Field-by-field comparison for the snapshot scalar/array fields; lists the names that differ. */
export function changedFields<T extends object>(before: T, after: T): string[] {
	const fields: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const a = (before as Record<string, unknown>)[key];
		const b = (after as Record<string, unknown>)[key];
		if (JSON.stringify(a) !== JSON.stringify(b)) fields.push(key);
	}
	return fields;
}

export function diffEntities<T extends object>(
	before: T[],
	after: T[],
	identity: (entity: T) => string,
): EntityDiff<T> {
	const beforeById = new Map(before.map(entity => [identity(entity), entity]));
	const afterById = new Map(after.map(entity => [identity(entity), entity]));
	const result: EntityDiff<T> = { added: [], removed: [], changed: [] };
	for (const [id, entity] of afterById) {
		const prior = beforeById.get(id);
		if (!prior) {
			result.added.push(entity);
			continue;
		}
		const fields = changedFields(prior, entity);
		if (fields.length) result.changed.push({ before: prior, after: entity, fields });
	}
	for (const [id, entity] of beforeById) {
		if (!afterById.has(id)) result.removed.push(entity);
	}
	return result;
}

// Exported for message-validation.ts (which borrows these parsers); kept here as the package's value-coercion home.
export function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

export function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// Guild-scoped entity collections (emoji/sticker/automod/scheduled-event/...) are all stored as
// `{ guildId, <entity> }[]` on the world. These three helpers collapse the otherwise-identical list/one/remove
// boilerplate; `pick` selects the entity out of its wrapper.
export function listByGuild<W extends { guildId: string }, E>(
	list: W[] | undefined,
	guildId: string,
	pick: (w: W) => E,
): E[] {
	return (list ?? []).filter(entry => entry.guildId === guildId).map(pick);
}
export function oneByGuild<W extends { guildId: string }, E extends { id: string }>(
	list: W[] | undefined,
	guildId: string,
	id: string,
	pick: (w: W) => E,
): E | undefined {
	const entry = (list ?? []).find(wrapper => wrapper.guildId === guildId && pick(wrapper).id === id);
	return entry ? pick(entry) : undefined;
}
export function removeByGuild<W extends { guildId: string }, E extends { id: string }>(
	list: W[] | undefined,
	guildId: string,
	id: string,
	pick: (w: W) => E,
): W[] {
	return (list ?? []).filter(entry => entry.guildId !== guildId || pick(entry).id !== id);
}

export function normalizeOverwrites(value: unknown): ChannelOverwriteLike[] {
	return arrayValue(value).map(overwrite => {
		const raw = asRecord(overwrite);
		return {
			id: stringValue(raw.id) ?? mockId(),
			type: numberValue(raw.type) ?? 0,
			allow: stringValue(raw.allow) ?? '0',
			deny: stringValue(raw.deny) ?? '0',
		};
	});
}

export function normalizeThreadMetadata(value: unknown): ThreadMetadata {
	const raw = asRecord(value);
	return {
		archived: typeof raw.archived === 'boolean' ? raw.archived : false,
		auto_archive_duration: numberValue(raw.auto_archive_duration) ?? 1440,
		locked: typeof raw.locked === 'boolean' ? raw.locked : false,
		archive_timestamp: stringValue(raw.archive_timestamp) ?? mockTimestamp(),
	};
}

export function normalizePoll(raw: Record<string, unknown>): ApiPoll {
	const question = asRecord(raw.question);
	return apiPoll({
		question: stringValue(question.text) === undefined ? {} : { text: stringValue(question.text) },
		answers: arrayValue(raw.answers).map(entry => {
			const media = asRecord(asRecord(entry).poll_media);
			return stringValue(media.text) === undefined ? {} : { text: stringValue(media.text) };
		}),
		...(numberValue(raw.duration) === undefined ? {} : { duration: numberValue(raw.duration) }),
		...(typeof raw.allow_multiselect === 'boolean' ? { allowMultiselect: raw.allow_multiselect } : {}),
		...(numberValue(raw.layout_type) === undefined ? {} : { layoutType: numberValue(raw.layout_type) }),
	});
}

export function normalizeAttachments(value: unknown): ApiAttachment[] {
	return arrayValue(value).map(entry => {
		const raw = asRecord(entry);
		return apiAttachment({
			...(stringValue(raw.id) === undefined ? {} : { id: stringValue(raw.id) }),
			...(stringValue(raw.filename) === undefined ? {} : { filename: stringValue(raw.filename) }),
			...(stringValue(raw.content_type) === undefined ? {} : { contentType: stringValue(raw.content_type) }),
			...(numberValue(raw.size) === undefined ? {} : { size: numberValue(raw.size) }),
			...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		});
	});
}

export function roleView(
	guildId: string,
	role: { id: string; name: string; position: number; permissions: string; color: number },
): RoleView {
	return {
		guildId,
		id: role.id,
		name: role.name,
		position: role.position,
		permissions: role.permissions,
		color: role.color,
	};
}

export function normalizeEmbed(value: unknown): EmbedView {
	// Unwrap a seyfert builder (Embed) — its fields live under .toJSON(), not as own properties — so this works
	// on both raw REST-body embeds (bot path) and stored builder instances (context path).
	const source =
		value && typeof (value as { toJSON?: unknown }).toJSON === 'function'
			? (value as { toJSON(): unknown }).toJSON()
			: value;
	const raw = asRecord(source);
	const fields = arrayValue(raw.fields).map(field => {
		const entry = asRecord(field);
		return {
			name: stringValue(entry.name) ?? '',
			value: stringValue(entry.value) ?? '',
			...(typeof entry.inline === 'boolean' ? { inline: entry.inline } : {}),
		};
	});
	return {
		...(stringValue(raw.title) === undefined ? {} : { title: stringValue(raw.title) }),
		...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		...(numberValue(raw.color) === undefined ? {} : { color: numberValue(raw.color) }),
		fields,
		...(asRecord(raw.footer).text === undefined ? {} : { footer: { text: String(asRecord(raw.footer).text) } }),
		...(asRecord(raw.author).name === undefined ? {} : { author: { name: String(asRecord(raw.author).name) } }),
		...(asRecord(raw.image).url === undefined ? {} : { image: { url: String(asRecord(raw.image).url) } }),
		...(asRecord(raw.thumbnail).url === undefined ? {} : { thumbnail: { url: String(asRecord(raw.thumbnail).url) } }),
	};
}

export function collectInteractiveComponents(value: unknown, out: InteractiveComponentView[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectInteractiveComponents(entry, out);
		return;
	}
	const raw = asRecord(value);
	const type = numberValue(raw.type);
	if (type !== undefined && type >= 2 && type <= 8) {
		const options = arrayValue(raw.options).map(option => {
			const opt = asRecord(option);
			return {
				...(stringValue(opt.label) === undefined ? {} : { label: stringValue(opt.label) }),
				...(stringValue(opt.value) === undefined ? {} : { value: stringValue(opt.value) }),
			};
		});
		out.push({
			type,
			...(stringValue(raw.custom_id) === undefined ? {} : { customId: stringValue(raw.custom_id) }),
			...(stringValue(raw.label) === undefined ? {} : { label: stringValue(raw.label) }),
			...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
			...(options.length > 0 ? { options } : {}),
		});
	}
	if (raw.accessory !== undefined) collectInteractiveComponents(raw.accessory, out);
	if (Array.isArray(raw.components)) collectInteractiveComponents(raw.components, out);
}

/**
 * Walk a (possibly nested) Components v2 tree — containers (17), sections (9, plus their `accessory`),
 * action rows (1), etc. — visiting every node so v2 layouts can be surfaced flat for assertions.
 */
export function walkComponents(value: unknown, visit: (node: Record<string, unknown>) => void): void {
	for (const entry of arrayValue(value)) {
		const node = asRecord(entry);
		visit(node);
		if (node.accessory !== undefined) visit(asRecord(node.accessory));
		if (Array.isArray(node.components)) walkComponents(node.components, visit);
	}
}

/**
 * Flatten a (possibly v2-nested) components tree into its interactive buttons, every node `type` in tree order,
 * and the TextDisplay (type 10) contents — the shared projection used by both the dispatch result and MessageView.
 */
export function harvestComponents(components: unknown): {
	components: InteractiveComponentView[];
	componentTypes: number[];
	textDisplays: string[];
} {
	const interactiveComponents: InteractiveComponentView[] = [];
	const componentTypes: number[] = [];
	const textDisplays: string[] = [];
	collectInteractiveComponents(components, interactiveComponents);
	walkComponents(components, node => {
		const type = numberValue(node.type);
		if (type !== undefined) componentTypes.push(type);
		if (type === 10 && typeof node.content === 'string') textDisplays.push(node.content);
	});
	return { components: interactiveComponents, componentTypes, textDisplays };
}

/**
 * The latest reply a dispatch rendered, extracted from its recorded REST actions — content + normalized
 * embeds/components. Handles both the interaction-callback body (`body.data.{...}`) and the webhook-edit body
 * (`body.{...}`). Powers `Dispatch.lastEmbeds()`/`lastComponents()` (assert a parked flow) and the
 * `untilComponent` "rendered X instead" diagnostic.
 */
export function renderedReply(
	actions: readonly RecordedAction[],
	dispatchId?: number,
): { content?: string; embeds: EmbedView[]; components: InteractiveComponentView[] } {
	for (let i = actions.length - 1; i >= 0; i--) {
		const action = actions[i];
		if (dispatchId !== undefined && action.dispatchId !== dispatchId) continue;
		const body = asRecord(action.body);
		const data = asRecord(body.data);
		const rawEmbeds = Array.isArray(body.embeds) ? body.embeds : Array.isArray(data.embeds) ? data.embeds : undefined;
		const rawComponents = body.components ?? data.components;
		const content = stringValue(body.content) ?? stringValue(data.content);
		if (rawEmbeds !== undefined || rawComponents !== undefined || content !== undefined) {
			return {
				...(content === undefined ? {} : { content }),
				embeds: (rawEmbeds ?? []).map(normalizeEmbed),
				components: harvestComponents(rawComponents).components,
			};
		}
	}
	return { embeds: [], components: [] };
}
