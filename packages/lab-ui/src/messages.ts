import type { AttachmentPayload, ComponentPayload, MessagePayload, VisibleMessage } from './bridge';

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
	FileUpload: 19,
	RadioGroup: 21,
	CheckboxGroup: 22,
	Checkbox: 23,
} as const;

const EPHEMERAL_FLAG = 64;
/** A deferred response: the bot has not answered yet. */
export const LOADING_FLAG = 128;
/** Components V2: the message shows its components, not its content or embeds. */
const COMPONENTS_V2_FLAG = 1 << 15;
const ATTACHMENT_PREFIX = 'attachment://';

export const isComponentsV2 = (flags?: number) => Boolean((flags ?? 0) & COMPONENTS_V2_FLAG);

/** `attachment://filename`, the reference Discord uses for a file on the same message. */
export const attachmentReference = (filename: string) => `${ATTACHMENT_PREFIX}${filename}`;

/** The message attachment a component points at, when the URL is an attachment reference. */
export function referencedAttachment(
	url: string | undefined,
	attachments: AttachmentPayload[] = [],
): AttachmentPayload | undefined {
	if (!url?.startsWith(ATTACHMENT_PREFIX)) return;
	return attachments.find(file => file.filename === url.slice(ATTACHMENT_PREFIX.length));
}

/** Every component in reading order, including nested rows and section accessories. */
export function* componentTree(components: ComponentPayload[] = []): Generator<ComponentPayload> {
	for (const component of components) {
		yield component;
		yield* componentTree(component.components);
		if (component.component) yield* componentTree([component.component]);
		if (component.accessory) yield component.accessory;
	}
}

/**
 * First text a person would read in the message: its content, an embed's title or description, or a text display.
 * Locators match it as a substring of the message's visible text, so it identifies the message across sessions.
 */
export function messageText(payload: MessagePayload): string | undefined {
	const v2 = isComponentsV2(payload.flags);
	if (!v2 && payload.content) return payload.content;
	const embed = !v2 && payload.embeds?.find(item => item.title || item.description);
	if (embed) return embed.title || embed.description;
	for (const component of componentTree(payload.components)) {
		if (component.type === ComponentType.TextDisplay && component.content) return component.content;
		if (component.type === ComponentType.File) {
			if (component.name) return component.name;
			const file = referencedAttachment(component.file?.url, payload.attachments);
			if (file) return file.filename;
		}
	}
	return undefined;
}

/** Same rule the message renderer uses to show "Only you can see this". */
export const isEphemeral = (message: VisibleMessage) =>
	message.visibility === 'ephemeral' || Boolean((message.payload.flags ?? 0) & EPHEMERAL_FLAG);
