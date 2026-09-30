import { useState } from 'react';
import type { ComponentPayload, MessageIntent } from '../bridge';
import { ExternalLinkIcon } from '../icons';
import { ComponentType } from '../messages';
import { mediaUrl } from './cdn';
import { EmojiLabel, Markdown, type NameMap } from './Markdown';
import { SelectMenu, type SelectOption } from './SelectMenu';

const LINK_BUTTON_STYLE = 5;

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

/** Message select: sends the interaction when a single value is picked or a multi-select is confirmed. */
function Select({
	component,
	onIntent,
	messageId,
	names,
}: {
	component: ComponentPayload;
	onIntent: (intent: MessageIntent) => void;
	messageId: string;
	names?: NameMap;
}) {
	const options: SelectOption[] =
		component.options ??
		Object.entries(entityNames(component.type, names) ?? {}).map(([value, label]) => ({ value, label }));
	const [selected, setSelected] = useState<string[]>(() =>
		options.filter(option => option.default).map(option => option.value),
	);
	return (
		<div className="message-select">
			<SelectMenu
				id={`select-${messageId}-${component.custom_id ?? 'menu'}`}
				options={options}
				selected={selected}
				onChange={setSelected}
				min={component.min_values ?? 1}
				max={component.max_values ?? 1}
				placeholder={component.placeholder ?? 'Make a selection'}
				disabled={component.disabled || !component.custom_id}
				onConfirm={values => {
					if (component.custom_id) onIntent({ verb: 'select', customId: component.custom_id, messageId, values });
				}}
			/>
		</div>
	);
}

function Button({
	component,
	onIntent,
	messageId,
}: {
	component: ComponentPayload;
	onIntent: (intent: MessageIntent) => void;
	messageId: string;
}) {
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
		<button
			className={`component-button button-style-${component.style ?? 2}`}
			type="button"
			disabled={component.disabled || !component.custom_id}
			onClick={() => component.custom_id && onIntent({ verb: 'click', customId: component.custom_id, messageId })}>
			{label}
		</button>
	);
}

/** One message component, rendered the way the Discord client shows it. */
export function Component({
	component,
	messageId,
	onIntent,
	names,
}: {
	component: ComponentPayload;
	messageId: string;
	onIntent: (intent: MessageIntent) => void;
	names?: NameMap;
}) {
	const children = (items?: ComponentPayload[]) =>
		items?.map((child, index) => (
			<Component key={child.id ?? index} component={child} messageId={messageId} onIntent={onIntent} names={names} />
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
			return <Select component={component} onIntent={onIntent} messageId={messageId} names={names} />;
		case ComponentType.Section:
			return (
				<div className="section">
					<div className="section-text">{children(component.components)}</div>
					{component.accessory && (
						<Component component={component.accessory} messageId={messageId} onIntent={onIntent} names={names} />
					)}
				</div>
			);
		case ComponentType.TextDisplay:
			return <Markdown text={component.content ?? ''} names={names} />;
		case ComponentType.Thumbnail: {
			const src = mediaUrl(component.media?.url);
			return src ? (
				<img className="section-thumbnail" src={src} alt={component.description ?? ''} />
			) : (
				<div className="media-placeholder thumbnail">{component.media?.url ?? 'Thumbnail'}</div>
			);
		}
		case ComponentType.MediaGallery:
			return (
				<div className="media-gallery">
					{component.items?.map((item, index) => {
						const src = mediaUrl(item.media?.url);
						return src ? (
							<img key={index} src={src} alt={item.description ?? ''} />
						) : (
							<div className="media-placeholder" key={index}>
								{item.description ?? item.media?.url ?? 'Image'}
							</div>
						);
					})}
				</div>
			);
		case ComponentType.File:
			return <div className="file-placeholder">📄 {component.file?.url ?? 'File'}</div>;
		case ComponentType.Separator:
			return <hr className={`component-separator ${component.divider === false ? 'blank' : ''}`} />;
		case ComponentType.Container:
			return (
				<div className="component-container" style={{ borderLeftColor: hex(component.color) }}>
					{children(component.components)}
				</div>
			);
		default:
			return <div className="unsupported">Unsupported component type {component.type}</div>;
	}
}
