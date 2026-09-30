import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Expectation, LabAction, LabClient, LabSnapshot, MessageIntent, MessagePayload } from '../bridge';
import { modalKey } from '../HostClient';
import { continues } from '../render/grouping';
import { LOCALE } from '../render/locale';
import { Avatar, Message } from '../render/Message';
import { Modal, type ModalValues } from '../render/Modal';
import { Composer } from './Composer';
import { ChevronIcon, CloseIcon, FlaskIcon, HashIcon, LockedHashIcon, MembersIcon, MenuIcon, PinIcon } from './icons';
import { LabPanel, type LabTab } from './LabPanel';
import { MemberList } from './MemberList';
import { ResumeForms, unreachableForms } from './ResumeForms';
import { defaultChoice, type ScenarioChoice, ScenarioForm } from './ScenarioForm';

type RightPanel = 'members' | 'lab' | undefined;

const dayOf = (value?: string) => {
	const date = value ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime())
		? date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })
		: undefined;
};

/** Server icons without artwork show initials, like Discord. */
const initials = (name: string) =>
	name
		.split(/\s+/)
		.map(word => word[0])
		.join('')
		.slice(0, 3);

const narrow = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1180px)').matches;

/** First text a person would read in the message; used as the default visible-message expectation. */
function visibleText(payload: MessagePayload): string | undefined {
	if (payload.content) return payload.content;
	const embed = payload.embeds?.find(item => item.title || item.description);
	if (embed) return embed.title ?? embed.description;
	const stack = [...(payload.components ?? [])];
	while (stack.length) {
		const component = stack.shift();
		if (component?.type === 10 && component.content) return component.content;
		stack.push(...(component?.components ?? []));
	}
	return undefined;
}

export function App({ client }: { client: LabClient }) {
	const [snapshot, setSnapshot] = useState<LabSnapshot | null>(null);
	const [error, setError] = useState('');
	const [actor, setActor] = useState('');
	const [guildId, setGuildId] = useState('');
	const [channel, setChannel] = useState('');
	// On narrow screens a side panel covers the conversation, so it starts closed there.
	const [panel, setPanel] = useState<RightPanel>(() => (narrow() ? undefined : 'members'));
	const [starting, setStarting] = useState(false);
	const [labTab, setLabTab] = useState<LabTab>('scenario');
	const [navOpen, setNavOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [choice, setChoice] = useState<ScenarioChoice>();
	const choiceProject = useRef<LabSnapshot['project']>(undefined);
	const [arrival, setArrival] = useState<Expectation[]>([]);
	const [checkpointStatus, setCheckpointStatus] = useState('');
	// What each open or closed modal holds, as a Discord client keeps it until the form is sent or replaced.
	const drafts = useRef(new Map<string, ModalValues>());
	const report = useCallback((value: string) => setError(value.replace(/^Error: /, '')), []);

	useEffect(() => {
		let active = true;
		const unsubscribe = client.subscribe(next => {
			if (active) setSnapshot(next);
		});
		void client
			.connect()
			.then(next => {
				if (active) setSnapshot(next);
			})
			.catch(reason => {
				if (active) setError(String(reason));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [client]);

	const running = snapshot?.connection === 'connected' && Boolean(snapshot.session);
	const guilds = snapshot?.session?.guilds ?? [];
	const actors = snapshot?.actors.filter(item => item.channelId) ?? [];
	const viewer = actors.find(item => item.key === actor);

	useEffect(() => {
		if (!snapshot) return;
		// A restarted or redeployed host brings its own catalogue; a choice from the old one may not exist.
		if (!choice || choiceProject.current !== snapshot.project) {
			choiceProject.current = snapshot.project;
			setChoice(defaultChoice(snapshot));
		}
		if (!running) return;
		const nextActor = actors.find(item => item.key === actor) ?? actors[0];
		if (!nextActor) return;
		if (nextActor.key !== actor) setActor(nextActor.key);
		const current = snapshot.channels.find(item => item.id === channel);
		if (!current) {
			setChannel(nextActor.channelId);
			setGuildId(snapshot.channels.find(item => item.id === nextActor.channelId)?.guildId ?? guilds[0]?.id ?? '');
		} else if (current.guildId !== guildId) setGuildId(current.guildId);
	}, [snapshot, running, actors, actor, channel, guildId, guilds, choice]);

	const pendingKeys = snapshot?.pending.modals.map(modalKey).join('|') ?? '';
	useEffect(() => {
		const live = new Set(pendingKeys.split('|'));
		for (const key of drafts.current.keys()) if (!live.has(key)) drafts.current.delete(key);
	}, [pendingKeys]);

	// Follow new messages only while the reader is already at the end, like Discord does.
	const messagesRef = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const viewKey = `${actor}:${channel}`;
	const messageSignature = (snapshot?.conversations[viewKey]?.messages ?? [])
		.map(item => `${item.id}:${item.editedAt ?? ''}`)
		.join('|');
	useLayoutEffect(() => {
		following.current = true;
	}, [viewKey]);
	useLayoutEffect(() => {
		const element = messagesRef.current;
		if (element && following.current && messageSignature) element.scrollTop = element.scrollHeight;
	}, [messageSignature, viewKey]);

	// The engine marks bot members in the session description; the UI never infers identity from messages.
	const botIds = useMemo(
		() =>
			new Set(
				snapshot?.session?.guilds.flatMap(guild => guild.members.filter(member => member.bot).map(member => member.id)),
			),
		[snapshot],
	);

	if (!snapshot)
		return (
			<main className="connection-screen">
				<h1>Seyfert Lab</h1>
				<p>{error ? `Could not connect to the lab host: ${error}` : 'Connecting…'}</p>
			</main>
		);

	const act = (action: LabAction) => void client.act(action).catch(reason => report(String(reason)));
	const guild = guilds.find(item => item.id === guildId);
	const channels = snapshot.channels.filter(item => item.guildId === guildId);
	const current = channels.find(item => item.id === channel);
	const canView = Boolean(current?.visibleTo.includes(actor));
	const conversation = snapshot.conversations[`${actor}:${channel}`];
	const modal = snapshot.pending.modals.find(
		item => item.userId === viewer?.userId && !snapshot.closedModals?.includes(modalKey(item)),
	);
	const failures = snapshot.inspector.rest.filter(item => item.failed).length;
	// The member list only exists for a running session; the lab panel is useful before one starts.
	const shownPanel = panel === 'lab' || (panel === 'members' && running) ? panel : undefined;
	const shownError = error || snapshot.error;

	function pin(expectation: Expectation) {
		setArrival(existing => [...existing, expectation]);
		setCheckpointStatus('Expectation added. Save a checkpoint to keep it.');
	}
	function start() {
		if (!choice || starting) return;
		setStarting(true);
		void client
			.start(choice)
			.then(() => {
				setArrival([]);
				setCheckpointStatus('');
				setPanel(current => (narrow() ? undefined : (current ?? 'members')));
			})
			.catch(reason => report(String(reason)))
			.finally(() => setStarting(false));
	}
	function intent(value: MessageIntent) {
		const source = { channel, messageRef: value.messageId, customId: value.customId };
		if (value.verb === 'click') act({ kind: 'user', verb: 'click', actor, customId: value.customId, source });
		else act({ kind: 'user', verb: 'select', actor, customId: value.customId, values: value.values ?? [], source });
	}
	function viewAs(key: string) {
		const next = actors.find(item => item.key === key);
		if (!next) return;
		setActor(key);
		if (!channels.some(item => item.id === channel)) setChannel(next.channelId);
		setSwitcherOpen(false);
	}
	function openLab(tab: LabTab) {
		setLabTab(tab);
		setPanel('lab');
	}
	function togglePanel(next: 'members' | 'lab') {
		setPanel(current => (current === next ? undefined : next));
	}

	const labPanel = choice && (
		<LabPanel
			snapshot={snapshot}
			client={client}
			tab={labTab}
			onTab={setLabTab}
			choice={choice}
			onChoice={setChoice}
			onStart={start}
			starting={starting}
			arrival={arrival}
			onArrival={setArrival}
			actor={actor}
			channel={channel}
			onReopenModal={key => client.reopenModal?.(key)}
			viewDiagnostics={conversation?.diagnostics.filter(item => item !== 'no-view-channel') ?? []}
			status={checkpointStatus}
			onStatus={setCheckpointStatus}
			report={report}
		/>
	);

	const title = running ? (guild?.name ?? snapshot.project.name) : snapshot.project.name;
	const dock = viewer && (
		<div className="user-dock">
			<button
				type="button"
				className="viewer-button"
				aria-expanded={switcherOpen}
				aria-haspopup="listbox"
				aria-label={`Viewing as ${viewer.name}. Switch actor`}
				onClick={() => setSwitcherOpen(!switcherOpen)}>
				<Avatar name={viewer.name} user={{ id: viewer.userId }} size={32} />
				<span>
					<strong>{viewer.name}</strong>
					<small>{viewer.key}</small>
				</span>
				<ChevronIcon />
			</button>
			{switcherOpen && (
				<ul className="actor-switcher" role="listbox" aria-label="Actors">
					{actors.map(item => (
						<li key={item.key}>
							<button type="button" role="option" aria-selected={item.key === actor} onClick={() => viewAs(item.key)}>
								<Avatar name={item.name} user={{ id: item.userId }} size={24} />
								<span>{item.name}</span>
								<code>{item.key}</code>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);

	return (
		<div className={`app ${navOpen ? 'nav-open' : ''}`}>
			<header className="titlebar">
				<span className="titlebar-title">
					{running && guild && <span className="titlebar-icon">{initials(guild.name)}</span>}
					<span>{title}</span>
				</span>
			</header>

			<nav className="server-rail" aria-label="Servers">
				<button
					type="button"
					className={`rail-item lab-home ${panel === 'lab' ? 'active' : ''}`}
					aria-label="Lab tools"
					title="Lab"
					onClick={() => (panel === 'lab' ? setPanel(undefined) : openLab('scenario'))}>
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
						onClick={() => {
							setGuildId(item.id);
							const first = snapshot.channels.find(
								entry => entry.guildId === item.id && entry.visibleTo.includes(actor),
							);
							setChannel(first?.id ?? snapshot.channels.find(entry => entry.guildId === item.id)?.id ?? '');
						}}>
						<span className="rail-pill" aria-hidden="true" />
						{initials(item.name)}
					</button>
				))}
			</nav>

			<div className={`shell ${shownPanel ? `with-${shownPanel}` : ''}`}>
				<aside className="channel-sidebar" aria-label="Channels">
					<header className="guild-header">
						<strong>{guild?.name ?? snapshot.project.name}</strong>
						<button
							type="button"
							className="icon-button nav-close"
							aria-label="Close navigation"
							onClick={() => setNavOpen(false)}>
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
													title={visible ? undefined : `${viewer?.name ?? actor} cannot view this channel`}
													onClick={() => {
														setChannel(item.id);
														setNavOpen(false);
													}}>
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

				<main className="chat">
					<header className="chat-header">
						<button
							type="button"
							className="icon-button nav-toggle"
							aria-label="Open channels"
							onClick={() => setNavOpen(true)}>
							<MenuIcon />
						</button>
						{running && current ? (
							<>
								{canView ? <HashIcon /> : <LockedHashIcon />}
								<h1>{current.name}</h1>
							</>
						) : (
							<h1 className="launcher-title">{snapshot.project.name}</h1>
						)}
						<div className="header-actions">
							{running && (
								<button
									type="button"
									className={`icon-button ${panel === 'members' ? 'active' : ''}`}
									aria-pressed={panel === 'members'}
									aria-label="Member list"
									title="Members"
									onClick={() => togglePanel('members')}>
									<MembersIcon />
								</button>
							)}
							<button
								type="button"
								className={`icon-button lab-toggle ${panel === 'lab' ? 'active' : ''}`}
								aria-pressed={panel === 'lab'}
								aria-label={`Lab tools${failures ? `, ${failures} failed REST calls` : ''}`}
								title="Lab"
								onClick={() => togglePanel('lab')}>
								<FlaskIcon />
								{failures > 0 && <span className="badge">{failures}</span>}
							</button>
						</div>
					</header>
					{running ? (
						<>
							<div
								className="messages"
								data-testid="conversation"
								aria-live="polite"
								ref={messagesRef}
								onScroll={event => {
									const element = event.currentTarget;
									following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
								}}>
								{canView ? (
									!conversation?.messages.length && <p className="channel-empty">No messages</p>
								) : (
									<div className="no-access">
										<LockedHashIcon size={48} />
										<h2>No access to #{current?.name}</h2>
									</div>
								)}
								{conversation?.messages.map((item, index, list) => {
									const text = visibleText(item.payload);
									const previous = list[index - 1];
									const day = dayOf(item.payload.timestamp);
									const newDay = day && day !== dayOf(previous?.payload.timestamp);
									return (
										<Fragment key={item.id}>
											{newDay && (
												<div className="date-divider" role="separator">
													<span>{day}</span>
												</div>
											)}
											<Message
												message={item}
												names={snapshot.names}
												onIntent={intent}
												onDismiss={
													client.dismissMessage && item.visibility === 'ephemeral' && item.ownerId === viewer?.userId
														? () =>
																void client
																	.dismissMessage?.(actor, channel, item)
																	.catch(reason => report(String(reason)))
														: undefined
												}
												continued={!newDay && continues(previous, item)}
												tools={
													client.saveCheckpoint &&
													text && (
														<button
															type="button"
															className="lab-mini"
															title="Expect this message"
															aria-label="Expect this message to be visible"
															onClick={() => pin({ view: { actor, channel }, contains: text })}>
															<PinIcon />
														</button>
													)
												}
											/>
										</Fragment>
									);
								})}
							</div>
							<ResumeForms
								forms={unreachableForms(
									snapshot.pending.modals,
									snapshot.closedModals ?? [],
									viewer?.userId,
									conversation?.messages ?? [],
								)}
								onReopen={key => client.reopenModal?.(key)}
							/>
							<Composer
								snapshot={snapshot}
								channelName={current?.name ?? ''}
								guildId={guildId}
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
						<div className="launcher">
							<div className="launcher-card">
								<h2>Start a scenario</h2>
								{snapshot.notice && (
									<p className="lab-callout" role="status">
										{snapshot.notice}
									</p>
								)}
								{checkpointStatus && (
									<p
										className={`lab-callout ${checkpointStatus.startsWith('FAIL') ? 'danger' : checkpointStatus.startsWith('PASS') ? 'ok' : ''}`}
										role="status">
										{checkpointStatus}
									</p>
								)}
								{choice && (
									<ScenarioForm
										snapshot={snapshot}
										choice={choice}
										onChange={setChoice}
										onStart={start}
										running={false}
										busy={starting}
									/>
								)}
								<button type="button" className="button link" onClick={() => openLab('checkpoints')}>
									Saved checkpoints
								</button>
							</div>
						</div>
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
						{shownPanel === 'lab'
							? labPanel
							: guild && (
									<MemberList
										snapshot={snapshot}
										guild={guild}
										botIds={botIds}
										viewer={actor}
										onViewAs={viewAs}
										onPin={client.saveCheckpoint ? pin : undefined}
										onRole={(member, op, role) => act({ kind: 'admin', op, guild: guild.id, member, role })}
									/>
								)}
					</aside>
				)}
			</div>

			{dock}
			<button type="button" className="scrim" aria-label="Close" tabIndex={-1} onClick={() => setNavOpen(false)} />

			{shownError && (
				<div className="toast" role="alert">
					<span>{shownError}</span>
					<button
						type="button"
						className="icon-button"
						aria-label="Dismiss"
						onClick={() => {
							setError('');
							client.clearError();
						}}>
						<CloseIcon size={16} />
					</button>
				</div>
			)}
			{modal && (
				<Modal
					key={modal.interactionId ?? modal.customId}
					modal={modal}
					draft={drafts.current.get(modalKey(modal))}
					onDraft={values => drafts.current.set(modalKey(modal), values)}
					onClose={() => client.closeModal(actor, modal.customId)}
					onSubmit={submission =>
						// A reopened form belongs to the channel it was opened in, not the one on screen now.
						act({
							kind: 'user',
							verb: 'submitModal',
							actor,
							channel: modal.source?.channelId ?? channel,
							...submission,
						})
					}
				/>
			)}
		</div>
	);
}
