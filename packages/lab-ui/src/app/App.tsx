import { useCallback, useState } from 'react';
import type { LabAction, LabClient, LabSnapshot, MessageIntent } from '../bridge';
import { hasCheckpoints, sessionChannels } from '../bridge';
import { errorText } from '../format';
import { CloseIcon, FlaskIcon, HashIcon, LockedHashIcon, MembersIcon, MenuIcon } from '../icons';
import { type CheckpointStatus, StatusCallout, useCheckpointDraft } from './CheckpointsTab';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import { LabPanel, type LabTab } from './LabPanel';
import { MemberList } from './MemberList';
import { ModalLayer } from './ModalLayer';
import { ChannelSidebar, initials, ServerRail } from './Navigation';
import { ResumeForms, unreachableForms } from './ResumeForms';
import { ScenarioForm, type ScenarioLauncher, useScenarioLauncher } from './ScenarioForm';
import { useLabSnapshot, useViewSelection, viewableActors } from './state';
import { UserDock } from './UserDock';

type SidePanel = 'members' | 'lab';

/** On narrow screens a side panel covers the conversation, so none opens by itself there. */
const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1180px)').matches;

function Launcher({
	snapshot,
	launcher,
	status,
	onCheckpoints,
}: {
	snapshot: LabSnapshot;
	launcher: ScenarioLauncher;
	status?: CheckpointStatus;
	onCheckpoints: () => void;
}) {
	return (
		<div className="launcher">
			<div className="launcher-card">
				<h2>Start a scenario</h2>
				{snapshot.notice && <StatusCallout status={{ text: snapshot.notice }} />}
				{status && <StatusCallout status={status} />}
				<ScenarioForm project={snapshot.project} launcher={launcher} running={false} />
				<button type="button" className="button link" onClick={onCheckpoints}>
					Saved checkpoints
				</button>
			</div>
		</div>
	);
}

/** The open channel's name, or the project's before a session, and the toggles for the side panels. */
function ChatHeader({
	title,
	canView,
	projectName,
	panel,
	membersAvailable,
	failures,
	onOpenNav,
	onToggle,
}: {
	title?: string;
	canView: boolean;
	projectName: string;
	panel?: SidePanel;
	membersAvailable: boolean;
	failures: number;
	onOpenNav: () => void;
	onToggle: (panel: SidePanel) => void;
}) {
	return (
		<header className="chat-header">
			<button type="button" className="icon-button nav-toggle" aria-label="Open channels" onClick={onOpenNav}>
				<MenuIcon />
			</button>
			{title ? (
				<>
					{canView ? <HashIcon /> : <LockedHashIcon />}
					<h1>{title}</h1>
				</>
			) : (
				<h1 className="launcher-title">{projectName}</h1>
			)}
			<div className="header-actions">
				{membersAvailable && (
					<button
						type="button"
						className={`icon-button ${panel === 'members' ? 'active' : ''}`}
						aria-pressed={panel === 'members'}
						aria-label="Member list"
						title="Members"
						onClick={() => onToggle('members')}>
						<MembersIcon />
					</button>
				)}
				<button
					type="button"
					className={`icon-button lab-toggle ${panel === 'lab' ? 'active' : ''}`}
					aria-pressed={panel === 'lab'}
					aria-label={`Lab tools${failures ? `, ${failures} failed REST calls` : ''}`}
					title="Lab"
					onClick={() => onToggle('lab')}>
					<FlaskIcon />
					{failures > 0 && <span className="badge">{failures}</span>}
				</button>
			</div>
		</header>
	);
}

function ErrorToast({ error, onDismiss }: { error: string; onDismiss: () => void }) {
	return (
		<div className="toast" role="alert">
			<span>{error}</span>
			<button type="button" className="icon-button" aria-label="Dismiss" onClick={onDismiss}>
				<CloseIcon size={16} />
			</button>
		</div>
	);
}

export function App({ client }: { client: LabClient }) {
	const { snapshot, connectError } = useLabSnapshot(client);
	if (!snapshot)
		return (
			<main className="connection-screen">
				<h1>Seyfert Lab</h1>
				<p>{connectError ? `Could not connect to the lab host: ${connectError}` : 'Connecting…'}</p>
			</main>
		);
	return <Lab client={client} snapshot={snapshot} />;
}

/** The Discord-like client around one snapshot: navigation, the conversation, side panels and modals. */
function Lab({ client, snapshot }: { client: LabClient; snapshot: LabSnapshot }) {
	const [error, setError] = useState('');
	const report = useCallback((reason: unknown) => setError(errorText(reason)), []);
	const selection = useViewSelection(snapshot);
	const { actor, guildId, channel } = selection;
	const [panel, setPanel] = useState<SidePanel | undefined>(() => (narrow() ? undefined : 'members'));
	const [labTab, setLabTab] = useState<LabTab>('scenario');
	const [navOpen, setNavOpen] = useState(false);
	const draft = useCheckpointDraft();
	const launcher = useScenarioLauncher(client, snapshot, {
		report,
		onStarted() {
			draft.reset();
			setPanel(open => (narrow() ? undefined : (open ?? 'members')));
		},
	});

	const { session } = snapshot;
	const running = Boolean(session);
	const actors = viewableActors(snapshot);
	const viewer = actors.find(item => item.key === actor);
	const guild = session?.guilds.find(item => item.id === guildId);
	const channels = sessionChannels(session).filter(item => item.guildId === guildId);
	const current = channels.find(item => item.id === channel);
	const canView = Boolean(current?.visibleTo.includes(actor));
	const messages = snapshot.conversations[`${actor}:${channel}`]?.messages ?? [];
	// The member list only exists for a running session; the lab panel is useful before one starts.
	const shownPanel = panel === 'lab' || (panel === 'members' && running) ? panel : undefined;
	const shownError = error || snapshot.error;
	const onPin = hasCheckpoints(client) ? draft.pin : undefined;

	const act = (action: LabAction) => void client.act(action).catch(report);
	function intent(value: MessageIntent) {
		const source = { channel, messageRef: value.messageId, customId: value.customId };
		if (value.verb === 'click') act({ kind: 'user', verb: 'click', actor, customId: value.customId, source });
		else act({ kind: 'user', verb: 'select', actor, customId: value.customId, values: value.values ?? [], source });
	}
	function openLab(tab: LabTab) {
		setLabTab(tab);
		setPanel('lab');
	}

	return (
		<div className={`app ${navOpen ? 'nav-open' : ''}`}>
			<header className="titlebar">
				<span className="titlebar-title">
					{guild && <span className="titlebar-icon">{initials(guild.name)}</span>}
					<span>{guild?.name ?? snapshot.project.name}</span>
				</span>
			</header>

			<ServerRail
				guilds={session?.guilds ?? []}
				guildId={guildId}
				labOpen={panel === 'lab'}
				onLab={() => (panel === 'lab' ? setPanel(undefined) : openLab('scenario'))}
				onGuild={selection.openGuild}
			/>

			<div className={`shell ${shownPanel ? `with-${shownPanel}` : ''}`}>
				<ChannelSidebar
					title={guild?.name ?? snapshot.project.name}
					channels={channels}
					channel={channel}
					actor={actor}
					viewerName={viewer?.name ?? actor}
					running={running}
					onChannel={id => {
						selection.openChannel(id);
						setNavOpen(false);
					}}
					onClose={() => setNavOpen(false)}
				/>

				<main className="chat">
					<ChatHeader
						title={running ? current?.name : undefined}
						canView={canView}
						projectName={snapshot.project.name}
						panel={panel}
						membersAvailable={running}
						failures={snapshot.inspector.rest.filter(item => item.failed).length}
						onOpenNav={() => setNavOpen(true)}
						onToggle={next => setPanel(open => (open === next ? undefined : next))}
					/>
					{running ? (
						<>
							<Conversation
								actor={actor}
								channel={channel}
								channelName={current?.name ?? ''}
								viewerId={viewer?.userId}
								canView={canView}
								messages={messages}
								names={session?.names}
								onIntent={intent}
								onPin={onPin}
								onDismiss={message => void client.dismissMessage(actor, channel, message).catch(report)}
							/>
							<ResumeForms
								forms={unreachableForms(snapshot.pending.modals, snapshot.closedModals, viewer?.userId, messages)}
								onReopen={key => client.reopenModal(key)}
							/>
							<Composer
								key={`${actor}:${channel}`}
								commands={snapshot.commands}
								projectName={snapshot.project.name}
								channelName={current?.name ?? ''}
								guild={guild}
								canView={canView}
								onRun={entry =>
									act({
										kind: 'user',
										verb: 'slash',
										actor,
										channel,
										command: entry.command,
										...(entry.group ? { group: entry.group } : {}),
										...(entry.subcommand ? { subcommand: entry.subcommand } : {}),
										options: entry.options,
									})
								}
							/>
						</>
					) : (
						<Launcher
							snapshot={snapshot}
							launcher={launcher}
							status={draft.status}
							onCheckpoints={() => openLab('checkpoints')}
						/>
					)}
				</main>

				{shownPanel && (
					<aside className={`side-panel ${shownPanel}`} aria-label={shownPanel === 'lab' ? 'Lab' : 'Members'}>
						<button
							type="button"
							className="icon-button panel-close"
							aria-label="Close panel"
							onClick={() => setPanel(undefined)}>
							<CloseIcon />
						</button>
						{shownPanel === 'lab' && (
							<LabPanel
								snapshot={snapshot}
								client={client}
								tab={labTab}
								onTab={setLabTab}
								launcher={launcher}
								draft={draft}
								actor={actor}
								channel={channel}
								report={report}
							/>
						)}
						{shownPanel === 'members' && guild && (
							<MemberList
								snapshot={snapshot}
								guild={guild}
								viewer={actor}
								onViewAs={selection.viewAs}
								onPin={onPin}
								onRole={(member, op, role) => act({ kind: 'admin', op, guild: guild.id, member, role })}
							/>
						)}
					</aside>
				)}
			</div>

			{viewer && <UserDock viewer={viewer} actors={actors} onViewAs={selection.viewAs} />}
			<button type="button" className="scrim" aria-label="Close" tabIndex={-1} onClick={() => setNavOpen(false)} />

			{shownError && (
				<ErrorToast
					error={shownError}
					onDismiss={() => {
						setError('');
						client.clearError();
					}}
				/>
			)}
			<ModalLayer
				pending={snapshot.pending.modals}
				closedModals={snapshot.closedModals}
				viewerId={viewer?.userId}
				onClose={customId => client.closeModal(actor, customId)}
				onSubmit={(submission, channelId) =>
					act({ kind: 'user', verb: 'submitModal', actor, channel: channelId ?? channel, ...submission })
				}
			/>
		</div>
	);
}
