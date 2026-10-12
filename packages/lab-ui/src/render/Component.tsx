import { useState } from 'react';
import {
	type AttachmentPayload,
	type ComponentPayload,
	channelsOfTypes,
	type Guild,
	type MessageIntent,
} from '../bridge';
import { ExternalLinkIcon } from '../icons';
import { ComponentType, referencedAttachment } from '../messages';
import { usePendingAction } from '../usePendingAction';
import { mediaUrl } from './cdn';
import { EmojiLabel, Markdown, type NameMap } from './Markdown';
import { Attachment, MediaImage, referencedMediaUrl } from './Media';
import { SelectMenu, type SelectOption } from './SelectMenu';

const LINK_BUTTON_STYLE = 5;

/** HTTPS URL a component can put in an image, after resolving `attachment://` against the message. */
function mediaSrc(url: string | undefined, attachments?: AttachmentPayload[]): string | undefined {
	return mediaUrl(url ? referencedMediaUrl(url, attachments) : undefined);
}

/** CSS color for an embed or container accent. */
export const hex = (color?: number) => (color === undefined ? undefined : `#${color.toString(16).padStart(6, '0')}`);

/** Auto-populated selects list the session's entities of their type. */
function entityNames(type: number, names: NameMap = {}): Record<string, string> | undefined {
	switch (type) {
		case ComponentType.UserSelect:
			return names.users;
		case ComponentType.RoleSelect:
			return names.roles;
		case ComponentType.MentionableSelect:
			return { ...names.users, ...names.roles };
		case ComponentType.ChannelSelect:
			return names.channels;
		default:
			return undefined;
	}
}

/** Resolve entity choices from the source guild, rather than the session-wide mention names. */
export function selectOptions(component: ComponentPayload, names?: NameMap, guild?: Guild): SelectOption[] {
	if (component.options) return component.options;
	const entities = guild
		? (entityNames(component.type, {
				users: Object.fromEntries(guild.members.map(member => [member.id, member.name])),
				roles: Object.fromEntries(guild.roles.map(role => [role.id, role.name])),
				channels: Object.fromEntries(
					channelsOfTypes(guild.channels, component.channel_types).map(channel => [channel.id, channel.name]),
				),
			}) ?? {})
		: (entityNames(component.type, names) ?? {});
	return Object.entries(entities).map(([value, label]) => ({
		value,
		label: Object.values(entities).filter(name => name === label).length > 1 ? `${label} (${value})` : label,
		default: component.default_values?.some(item => item.id === value),
	}));
}

/** Message select: sends the interaction when a single value is picked or a multi-select is confirmed. */
function Select({
	component,
	onIntent,
	messageId,
	names,
	guild,
}: {
	component: ComponentPayload;
	onIntent: (intent: MessageIntent) => void | Promise<void>;
	messageId: string;
	names?: NameMap;
	guild?: Guild;
}) {
	const { pending, error, run } = usePendingAction();
	const options = selectOptions(component, names, guild);
	const [selected, setSelected] = useState<string[]>(() =>
		options.filter(option => option.default).map(option => option.value),
	);
	return (
		<div className="message-select" aria-busy={pending}>
			<SelectMenu
				id={`select-${messageId}-${component.custom_id ?? 'menu'}`}
				options={options}
				selected={selected.filter(value => options.some(option => option.value === value))}
				onChange={setSelected}
				min={component.min_values ?? 1}
				max={component.max_values ?? 1}
				placeholder={component.placeholder ?? 'Make a selection'}
				disabled={pending || component.disabled || !component.custom_id}
				onConfirm={values => {
					const customId = component.custom_id;
					if (customId) void run(() => onIntent({ verb: 'select', customId, messageId, values }));
				}}
				busy={pending}
			/>
			{error && (
				<p className="interaction-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}

function Button({
	component,
	onIntent,
	messageId,
}: {
	component: ComponentPayload;
	onIntent: (intent: MessageIntent) => void | Promise<void>;
	messageId: string;
}) {
	const { pending, error, run } = usePendingAction();
	const label = (
		<>
			{component.emoji && <EmojiLabel emoji={component.emoji} />}
			{component.label && <span>{component.label}</span>}
		</>
	);
	if (component.style === LINK_BUTTON_STYLE && component.url)
		return (
			<a
				className={`component-button button-style-${LINK_BUTTON_STYLE}`}
				href={component.url}
				target="_blank"
				rel="noreferrer">
				{label}
				<ExternalLinkIcon />
			</a>
		);
	return (
		<span className="message-button">
			<button
				className={`component-button button-style-${component.style ?? 2}`}
				type="button"
				data-custom-id={component.custom_id}
				aria-busy={pending}
				disabled={pending || component.disabled || !component.custom_id}
				onClick={() => {
					const customId = component.custom_id;
					if (customId) void run(() => onIntent({ verb: 'click', customId, messageId }));
				}}>
				{pending && <span className="action-spinner" aria-hidden="true" />}
				{label}
			</button>
			{error && (
				<span className="interaction-error" role="alert">
					{error}
				</span>
			)}
		</span>
	);
}

function GalleryItem({ src, description, spoiler }: { src: string; description?: string; spoiler?: boolean }) {
	const [revealed, setRevealed] = useState(false);
	return spoiler && !revealed ? (
		<button className="attachment-spoiler" type="button" onClick={() => setRevealed(true)}>
			Reveal spoiler image
		</button>
	) : (
		<MediaImage url={src} className="gallery-image" alt={description ?? ''} />
	);
}

/** One message component, rendered the way the Discord client shows it. */
export function Component({
	component,
	messageId,
	onIntent,
	names,
	guild,
	attachments,
}: {
	component: ComponentPayload;
	messageId: string;
	onIntent: (intent: MessageIntent) => void | Promise<void>;
	names?: NameMap;
	guild?: Guild;
	attachments?: AttachmentPayload[];
}) {
	const [revealed, setRevealed] = useState(false);
	if (component.spoiler && !revealed)
		return (
			<button className="attachment-spoiler" type="button" onClick={() => setRevealed(true)}>
				Reveal spoiler
			</button>
		);
	const children = (items?: ComponentPayload[]) =>
		items?.map((child, index) => (
			<Component
				key={child.id ?? index}
				component={child}
				messageId={messageId}
				onIntent={onIntent}
				names={names}
				guild={guild}
				attachments={attachments}
			/>
		));
	switch (component.type) {
		case ComponentType.ActionRow:
			return <div className="action-row">{children(component.components)}</div>;
		case ComponentType.Button:
			return <Button component={component} onIntent={onIntent} messageId={messageId} />;
		case ComponentType.StringSelect:
		case ComponentType.UserSelect:
		case ComponentType.RoleSelect:
		case ComponentType.MentionableSelect:
		case ComponentType.ChannelSelect:
			return (
				<Select
					key={JSON.stringify([
						component.custom_id,
						component.options,
						component.default_values,
						component.channel_types,
					])}
					component={component}
					onIntent={onIntent}
					messageId={messageId}
					names={names}
					guild={guild}
				/>
			);
		case ComponentType.Section:
			return (
				<div className="section">
					<div className="section-text">{children(component.components)}</div>
					{component.accessory && children([component.accessory])}
				</div>
			);
		case ComponentType.TextDisplay:
			return <Markdown text={component.content ?? ''} names={names} />;
		case ComponentType.Thumbnail: {
			const src = mediaSrc(component.media?.url, attachments);
			return src ? (
				<MediaImage key={src} className="section-thumbnail" url={src} alt={component.description ?? ''} />
			) : (
				<div className="media-placeholder thumbnail">{component.media?.url ?? 'Thumbnail'}</div>
			);
		}
		case ComponentType.MediaGallery:
			return (
				<div className="media-gallery">
					{component.items?.map((item, index) => {
						const src = mediaSrc(item.media?.url, attachments);
						return src ? (
							<GalleryItem key={`${index}:${src}`} src={src} description={item.description} spoiler={item.spoiler} />
						) : (
							<div className="media-placeholder" key={index}>
								{item.description ?? item.media?.url ?? 'Image'}
							</div>
						);
					})}
				</div>
			);
		case ComponentType.File: {
			const file = component.file;
			const attachment =
				referencedAttachment(file?.url, attachments) ??
				(file && component.name
					? {
							id: file.attachment_id ?? file.id ?? String(component.id ?? file.url),
							filename: component.name,
							url: file.url,
							size: component.size,
							content_type: file.content_type,
						}
					: undefined);
			return attachment ? (
				<Attachment attachment={attachment} />
			) : (
				<div className="file-placeholder">📄 {component.file?.url ?? 'File'}</div>
			);
		}
		case ComponentType.Separator:
			return (
				<hr
					className={`component-separator ${component.divider === false ? 'blank' : ''} ${component.spacing === 2 ? 'large' : ''}`}
				/>
			);
		case ComponentType.Container:
			return (
				<div className="component-container" style={{ borderLeftColor: hex(component.accent_color) }}>
					{children(component.components)}
				</div>
			);
		default:
			return <div className="unsupported">Unsupported component type {component.type}</div>;
	}
}
