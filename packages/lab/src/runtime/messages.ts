import type { VisibleMessage } from '@slipher/testing';
import { ComponentType } from 'seyfert/lib/types';
import { isRecord } from '../protocol';

const SELECT_TYPES: readonly unknown[] = [
	ComponentType.StringSelect,
	ComponentType.UserSelect,
	ComponentType.RoleSelect,
	ComponentType.MentionableSelect,
	ComponentType.ChannelSelect,
];

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Text a user reads on a message, in display order: content, embed text, then component text.
 * Custom IDs and other metadata are excluded, so `contains` matches what is on screen.
 */
export function visibleMessageText(payload: VisibleMessage['payload']): string[] {
	const text: string[] = payload.content ? [payload.content] : [];
	for (const embed of payload.embeds) {
		const fields = embed.fields?.flatMap(field => [field.name, field.value]) ?? [];
		text.push(...[embed.title, embed.description, ...fields, embed.footer?.text, embed.author?.name].filter(isString));
	}
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;
		if (value.type === ComponentType.TextDisplay && isString(value.content)) text.push(value.content);
		if (value.type === ComponentType.Button && isString(value.label)) text.push(value.label);
		if (SELECT_TYPES.includes(value.type)) {
			if (isString(value.placeholder)) text.push(value.placeholder);
			if (Array.isArray(value.options))
				for (const option of value.options) if (isRecord(option) && isString(option.label)) text.push(option.label);
		}
		visit(value.components);
		visit(value.accessory);
	};
	visit(payload.components);
	return text;
}

export const messageShows = (message: VisibleMessage, contains: string): boolean =>
	visibleMessageText(message.payload).some(text => text.includes(contains));

export function hasCustomId(components: unknown, customId: string): boolean {
	if (Array.isArray(components)) return components.some(item => hasCustomId(item, customId));
	return (
		isRecord(components) &&
		(components.custom_id === customId ||
			hasCustomId(components.components, customId) ||
			hasCustomId(components.accessory, customId))
	);
}
