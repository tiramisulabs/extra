import type { ComponentPayload, MessagePayload, VisibleMessage } from './bridge';

/** Discord component types the lab renders. */
export const ComponentType = {
	ActionRow: 1,
	Button: 2,
	StringSelect: 3,
	TextInput: 4,
	UserSelect: 5,
	RoleSelect: 6,
	MentionableSelect: 7,
	ChannelSelect: 8,
	Section: 9,
	TextDisplay: 10,
	Thumbnail: 11,
	MediaGallery: 12,
	File: 13,
	Separator: 14,
	Container: 17,
	Label: 18,
} as const;

const EPHEMERAL_FLAG = 64;
/** A deferred response: the bot has not answered yet. */
export const LOADING_FLAG = 128;

/** Every component in reading order, including nested rows and section accessories. */
export function* componentTree(components: ComponentPayload[] = []): Generator<ComponentPayload> {
	for (const component of components) {
		yield component;
		yield* componentTree(component.components);
		if (component.accessory) yield component.accessory;
	}
}

/**
 * First text a person would read in the message: its content, an embed's title or description, or a text display.
 * Locators match it as a substring of the message's visible text, so it identifies the message across sessions.
 */
export function messageText(payload: MessagePayload): string | undefined {
	if (payload.content) return payload.content;
	const embed = payload.embeds?.find(item => item.title || item.description);
	if (embed) return embed.title || embed.description;
	for (const component of componentTree(payload.components))
		if (component.type === ComponentType.TextDisplay && component.content) return component.content;
	return undefined;
}

/** Same rule the message renderer uses to show "Only you can see this". */
export const isEphemeral = (message: VisibleMessage) =>
	message.visibility === 'ephemeral' || Boolean((message.payload.flags ?? 0) & EPHEMERAL_FLAG);
