import type { Guild, LabSnapshot } from '../bridge';
import { ChevronIcon, CloseIcon, FlaskIcon, HashIcon, LockedHashIcon } from '../icons';

/** Server icons without artwork show initials, like Discord. */
export const initials = (name: string) =>
	name
		.split(/\s+/)
		.map(word => word[0])
		.join('')
		.slice(0, 3);

export function ServerRail({
	guilds,
	guildId,
	labOpen,
	onLab,
	onGuild,
}: {
	guilds: Guild[];
	guildId: string;
	labOpen: boolean;
	onLab: () => void;
	onGuild: (id: string) => void;
}) {
	return (
		<nav className="server-rail" aria-label="Servers">
			<button
				type="button"
				className={`rail-item lab-home ${labOpen ? 'active' : ''}`}
				aria-label="Lab tools"
				title="Lab"
				onClick={onLab}>
				<FlaskIcon size={22} />
			</button>
			<div className="rail-separator" />
			{guilds.map(item => (
				<button
					type="button"
					key={item.id}
					className={`rail-item ${item.id === guildId ? 'active' : ''}`}
					aria-label={item.name}
					aria-current={item.id === guildId ? 'page' : undefined}
					title={item.name}
					onClick={() => onGuild(item.id)}>
					<span className="rail-pill" aria-hidden="true" />
					{initials(item.name)}
				</button>
			))}
		</nav>
	);
}

export function ChannelSidebar({
	title,
	channels,
	channel,
	actor,
	viewerName,
	running,
	onChannel,
	onClose,
}: {
	title: string;
	channels: LabSnapshot['channels'];
	channel: string;
	actor: string;
	viewerName: string;
	running: boolean;
	onChannel: (id: string) => void;
	onClose: () => void;
}) {
	return (
		<aside className="channel-sidebar" aria-label="Channels">
			<header className="guild-header">
				<strong>{title}</strong>
				<button type="button" className="icon-button nav-close" aria-label="Close navigation" onClick={onClose}>
					<CloseIcon />
				</button>
			</header>
			<div className="channel-scroll">
				{running ? (
					<>
						<h2 className="channel-category">
							Text Channels <ChevronIcon size={12} />
						</h2>
						<ul className="channel-list">
							{channels.map(item => {
								const visible = item.visibleTo.includes(actor);
								return (
									<li key={item.id}>
										<button
											type="button"
											className={`channel-link ${item.id === channel ? 'active' : ''} ${visible ? '' : 'no-access'}`}
											aria-current={item.id === channel ? 'page' : undefined}
											title={visible ? undefined : `${viewerName} cannot view this channel`}
											onClick={() => onChannel(item.id)}>
											{visible ? <HashIcon /> : <LockedHashIcon />}
											<span>{item.name}</span>
											{!visible && <span className="sr-only">(no access)</span>}
										</button>
									</li>
								);
							})}
						</ul>
					</>
				) : (
					<p className="sidebar-empty">No session</p>
				)}
			</div>
		</aside>
	);
}
