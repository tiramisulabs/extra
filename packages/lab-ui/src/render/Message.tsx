import { type ReactNode, useState } from 'react';
import type { ComponentPayload, MessageIntent, MessagePayload, VisibleMessage } from '../bridge';
import { avatarUrl, mediaUrl } from './cdn';
import { isEphemeral } from './grouping';
import { LOCALE } from './locale';
import { EmojiLabel, Markdown, type NameMap } from './Markdown';
import { SelectMenu, type SelectOption } from './SelectMenu';

const INITIAL_COLORS = ['#5865f2', '#757e8a', '#3ba55c', '#faa61a', '#ed4245', '#eb459e'];

/** CDN avatar (custom or Discord's default for the ID); initials only when there is no usable ID or it fails. */
export function Avatar({
	name,
	user,
	size = 40,
}: {
	name: string;
	user?: { id?: string; avatar?: string | null };
	size?: number;
}) {
	const [failed, setFailed] = useState(false);
	const src = failed ? undefined : avatarUrl(user, size <= 32 ? 64 : 128);
	if (src)
		return (
			<img
				className="avatar"
				src={src}
				alt=""
				width={size}
				height={size}
				draggable={false}
				onError={() => setFailed(true)}
			/>
		);
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (
		<span
			className="avatar"
			aria-hidden="true"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.42,
				background: INITIAL_COLORS[Math.abs(hash) % INITIAL_COLORS.length],
			}}>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

const hex = (color?: number) => (color === undefined ? undefined : `#${color.toString(16).padStart(6, '0')}`);

function Unsupported({ what }: { what: string }) {
	return <div className="unsupported">Unsupported {what}</div>;
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
	const resolved =
		component.type === 5
			? names?.users
			: component.type === 6
				? names?.roles
				: component.type === 7
					? { ...names?.users, ...names?.roles }
					: component.type === 8
						? names?.channels
						: undefined;
	const options: SelectOption[] =
		component.options ?? Object.entries(resolved ?? {}).map(([value, label]) => ({ value, label }));
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
		case 1:
			return <div className="action-row">{children(component.components)}</div>;
		case 2: {
			const label = (
				<>
					{component.emoji && <EmojiLabel emoji={component.emoji} />}
					{component.label && <span>{component.label}</span>}
				</>
			);
			if (component.style === 5 && component.url)
				return (
					<a className="component-button button-style-5" href={component.url} target="_blank" rel="noreferrer">
						{label}
						<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path
								d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
							/>
						</svg>
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
		case 3:
		case 5:
		case 6:
		case 7:
		case 8:
			return <Select component={component} onIntent={onIntent} messageId={messageId} names={names} />;
		case 9:
			return (
				<div className="section">
					<div className="section-text">{children(component.components)}</div>
					{component.accessory && (
						<Component component={component.accessory} messageId={messageId} onIntent={onIntent} names={names} />
					)}
				</div>
			);
		case 10:
			return <Markdown text={component.content ?? ''} names={names} />;
		case 11: {
			const src = mediaUrl(component.media?.url);
			return src ? (
				<img className="section-thumbnail" src={src} alt={component.description ?? ''} />
			) : (
				<div className="media-placeholder thumbnail">{component.media?.url ?? 'Thumbnail'}</div>
			);
		}
		case 12:
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
		case 13:
			return <div className="file-placeholder">📄 {component.file?.url ?? 'File'}</div>;
		case 14:
			return <hr className={`component-separator ${component.divider === false ? 'blank' : ''}`} />;
		case 17:
			return (
				<div className="component-container" style={{ borderLeftColor: hex(component.color) }}>
					{children(component.components)}
				</div>
			);
		default:
			return <Unsupported what={`component type ${component.type}`} />;
	}
}

type Embed = NonNullable<MessagePayload['embeds']>[number];

/** Linked image with a visible placeholder when the URL is unusable or fails to load. */
function EmbedImage({ url, className }: { url: string; className: string }) {
	const [failed, setFailed] = useState(false);
	const src = mediaUrl(url);
	return src && !failed ? (
		<img className={className} src={src} alt="" onError={() => setFailed(true)} />
	) : (
		<div className={`media-placeholder ${className}`}>{url}</div>
	);
}

/** Small round icon (embed author/footer); hidden if it cannot load, as Discord does. */
function EmbedIcon({ url }: { url?: string }) {
	const [failed, setFailed] = useState(false);
	const src = mediaUrl(url);
	return src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : null;
}

function MessageEmbed({ embed, names }: { embed: Embed; names?: NameMap }) {
	const title = embed.title && <Markdown text={embed.title} names={names} />;
	return (
		<div className={`embed ${embed.thumbnail ? 'with-thumbnail' : ''}`} style={{ borderLeftColor: hex(embed.color) }}>
			<div className="embed-grid">
				{embed.author && (
					<div className="embed-author">
						<EmbedIcon url={embed.author.icon_url} />
						{embed.author.url ? (
							<a href={embed.author.url} target="_blank" rel="noreferrer">
								{embed.author.name}
							</a>
						) : (
							<span>{embed.author.name}</span>
						)}
					</div>
				)}
				{title && (
					<div className="embed-title">
						{embed.url ? (
							<a href={embed.url} target="_blank" rel="noreferrer">
								{title}
							</a>
						) : (
							title
						)}
					</div>
				)}
				{embed.description && (
					<div className="embed-description">
						<Markdown text={embed.description} names={names} />
					</div>
				)}
				{embed.fields && embed.fields.length > 0 && (
					<div className="embed-fields">
						{embed.fields.map((field, index) => (
							<div key={index} className={`embed-field ${field.inline ? 'inline' : ''}`}>
								<div className="embed-field-name">
									<Markdown text={field.name} names={names} />
								</div>
								<div className="embed-field-value">
									<Markdown text={field.value} names={names} />
								</div>
							</div>
						))}
					</div>
				)}
				{embed.image && <EmbedImage url={embed.image.url} className="embed-image" />}
				{(embed.footer || embed.timestamp) && (
					<div className="embed-footer">
						<EmbedIcon url={embed.footer?.icon_url} />
						<span>
							{embed.footer?.text}
							{embed.footer && embed.timestamp && ' • '}
							{embed.timestamp && messageTime(embed.timestamp)}
						</span>
					</div>
				)}
			</div>
			{embed.thumbnail && <EmbedImage url={embed.thumbnail.url} className="embed-thumbnail" />}
		</div>
	);
}

export function messageTime(value?: string) {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? undefined
		: date.toLocaleString(LOCALE, {
				day: '2-digit',
				month: '2-digit',
				year: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			});
}

const shortTime = (value?: string) => {
	const date = value ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime())
		? date.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
		: undefined;
};

export function Message({
	message,
	onIntent,
	names,
	tools,
	onDismiss,
	continued = false,
}: {
	message: VisibleMessage;
	onIntent: (intent: MessageIntent) => void;
	names?: NameMap;
	tools?: ReactNode;
	/** Present for the viewer's own ephemeral messages, which Discord lets them dismiss. */
	onDismiss?: () => void;
	/** Same author shortly after the previous message: Discord drops the avatar and header. */
	continued?: boolean;
}) {
	const payload = message.payload;
	const author = payload.author?.global_name ?? payload.author?.username ?? 'Bot';
	const ephemeral = isEphemeral(message);
	const thinking = message.deferred || Boolean((payload.flags ?? 0) & 128);
	const plainOnly = !payload.embeds?.length && !payload.components?.length;
	return (
		<article
			className={`message ${ephemeral ? 'ephemeral' : ''} ${continued ? 'continued' : ''}`}
			data-message-id={message.id}>
			{continued ? (
				<time className="gutter-time" dateTime={payload.timestamp}>
					{shortTime(payload.timestamp)}
				</time>
			) : (
				<Avatar name={author} user={payload.author} />
			)}
			<div className="message-body">
				{!continued && (
					<header className="message-meta">
						<strong className="author">{author}</strong>
						{payload.author?.bot && <span className="bot-tag">APP</span>}
						{messageTime(payload.timestamp) && (
							<time dateTime={payload.timestamp}>{messageTime(payload.timestamp)}</time>
						)}
					</header>
				)}
				{thinking ? (
					<p className="thinking">
						<span aria-hidden="true" className="dots">
							<i />
							<i />
							<i />
						</span>
						{author} is thinking…
					</p>
				) : (
					payload.content && (
						<div className="message-content">
							<Markdown text={payload.content} names={names} jumboAllowed={plainOnly} />
							{message.editedAt && <span className="edited">(edited)</span>}
						</div>
					)
				)}
				{!payload.content && message.editedAt && <span className="edited">(edited)</span>}
				{payload.embeds?.map((embed, index) => (
					<MessageEmbed key={index} embed={embed} names={names} />
				))}
				{payload.components?.map((component, index) => (
					<Component
						key={component.id ?? index}
						component={component}
						messageId={message.id}
						onIntent={onIntent}
						names={names}
					/>
				))}
				{ephemeral && (
					<p className="ephemeral-note">
						<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path
								fill="currentColor"
								d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"
							/>
						</svg>
						<span>Only you can see this</span>
						{onDismiss && (
							<>
								<span aria-hidden="true">·</span>
								<button type="button" className="text-link" onClick={onDismiss}>
									Dismiss message
								</button>
							</>
						)}
					</p>
				)}
			</div>
			{tools && <div className="message-tools">{tools}</div>}
		</article>
	);
}
