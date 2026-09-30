import { useState } from 'react';
import type { Expectation, InspectorEntry, JsonValue, LabClient, LabSnapshot } from '../bridge';
import { shortRevision } from '../HostClient';
import { CheckpointsTab } from './CheckpointsTab';
import { type ScenarioChoice, ScenarioForm } from './ScenarioForm';

export const LAB_TABS = [
	['scenario', 'Scenario'],
	['log', 'Log'],
	['rest', 'REST'],
	['pending', 'Pending'],
	['world', 'World'],
	['diagnostics', 'Diagnostics'],
	['project', 'Project'],
	['checkpoints', 'Checkpoints'],
] as const;
export type LabTab = (typeof LAB_TABS)[number][0];

function kindOf(label: string) {
	const kind = label.split(' ')[0];
	return kind === 'USER' || kind === 'ADMIN' || kind === 'LOCAL' ? kind.toLowerCase() : undefined;
}

function Entries({ items, empty }: { items: InspectorEntry[]; empty: string }) {
	if (!items.length) return <p className="lab-empty">{empty}</p>;
	return (
		<ol className="lab-entries">
			{items.map(item => {
				const kind = kindOf(item.label);
				return (
					<li key={item.id} className={item.failed ? 'failed' : ''}>
						<div className="entry-head">
							{kind && <span className={`kind-badge ${kind}`}>{kind}</span>}
							{item.failed && <span className="kind-badge failed">failed</span>}
							<span className="entry-label">{kind ? item.label.replace(/^\w+ · /, '') : item.label}</span>
						</div>
						{item.detail && <pre className="entry-detail">{item.detail}</pre>}
					</li>
				);
			})}
		</ol>
	);
}

function Json({ value }: { value: JsonValue | undefined }) {
	return <pre className="json-view">{value === undefined ? '—' : JSON.stringify(value, null, 2)}</pre>;
}

export function LabPanel({
	snapshot,
	client,
	tab,
	onTab,
	choice,
	onChoice,
	onStart,
	starting,
	arrival,
	onArrival,
	actor,
	channel,
	onReopenModal,
	viewDiagnostics,
	status,
	onStatus,
	report,
}: {
	snapshot: LabSnapshot;
	client: LabClient;
	tab: LabTab;
	onTab: (tab: LabTab) => void;
	choice: ScenarioChoice;
	onChoice: (choice: ScenarioChoice) => void;
	onStart: () => void;
	starting: boolean;
	arrival: Expectation[];
	onArrival: (next: Expectation[]) => void;
	actor: string;
	channel: string;
	onReopenModal: (key: string) => void;
	/** Engine notes for the conversation on screen (what this actor cannot see and why). */
	viewDiagnostics: string[];
	status: string;
	onStatus: (status: string) => void;
	report: (error: string) => void;
}) {
	const [worldOpen, setWorldOpen] = useState(false);
	const running = snapshot.connection === 'connected';
	const failures = snapshot.inspector.rest.filter(item => item.failed).length;
	const counts: Partial<Record<LabTab, number>> = {
		log: snapshot.inspector.actions.length,
		rest: failures,
		pending: snapshot.pending.modals.length + snapshot.pending.collectors.length,
		diagnostics: snapshot.inspector.diagnostics.length + viewDiagnostics.length,
		checkpoints: arrival.length,
	};
	return (
		<div className="lab-panel">
			<header className="lab-header">
				<div>
					<strong>{snapshot.project.name}</strong>
					<small>
						{running && snapshot.session
							? `${snapshot.session.preset.scenario.id}@${snapshot.session.preset.scenario.version}`
							: 'No session'}
					</small>
				</div>
				{snapshot.host?.build && (
					<a
						className="revision-chip"
						href={snapshot.host.build.url}
						target="_blank"
						rel="noreferrer"
						title={`Revision ${snapshot.host.build.revision}`}>
						{shortRevision(snapshot.host.build.revision)}
						{snapshot.host.build.ref && ` · ${snapshot.host.build.ref}`}
					</a>
				)}
			</header>
			<div className="lab-tabs" role="tablist" aria-label="Lab tools">
				{LAB_TABS.map(([id, label]) => (
					<button
						key={id}
						type="button"
						role="tab"
						id={`lab-tab-${id}`}
						aria-selected={tab === id}
						aria-controls="lab-tabpanel"
						className={tab === id ? 'active' : ''}
						onClick={() => onTab(id)}>
						{label}
						{Boolean(counts[id]) && <span className={`tab-count ${id === 'rest' ? 'danger' : ''}`}>{counts[id]}</span>}
					</button>
				))}
			</div>
			<div className="lab-body" role="tabpanel" id="lab-tabpanel" aria-labelledby={`lab-tab-${tab}`}>
				{tab === 'scenario' && (
					<>
						{running ? (
							<ScenarioForm
								snapshot={snapshot}
								choice={choice}
								onChange={onChoice}
								onStart={onStart}
								running
								busy={starting}
							/>
						) : null}
						{snapshot.session && (
							<section className="lab-section">
								<h3>Refs</h3>
								<dl className="refs">
									{Object.entries(snapshot.session.refs).map(([name, id]) => (
										<div key={name}>
											<dt>{name}</dt>
											<dd>
												<code>{id}</code>
											</dd>
										</div>
									))}
								</dl>
							</section>
						)}
					</>
				)}
				{tab === 'log' && <Entries items={snapshot.inspector.actions} empty="No actions yet." />}
				{tab === 'rest' && (
					<>
						<Entries items={snapshot.inspector.rest} empty="No REST calls yet." />
					</>
				)}
				{tab === 'pending' && (
					<>
						<section className="lab-section">
							<h3>Modals</h3>
							{snapshot.pending.modals.length ? (
								<ul className="pending-list">
									{snapshot.pending.modals.map(modal => {
										const key = modal.interactionId ?? `${modal.userId}:${modal.customId}`;
										const owner = snapshot.actors.find(item => item.userId === modal.userId);
										const closed = snapshot.closedModals?.includes(key);
										return (
											<li key={key}>
												<strong>{modal.payload.title}</strong>
												<code>{modal.customId}</code>
												<span>
													{owner?.name ?? modal.userId}
													{closed ? ' · closed locally' : ''}
												</span>
												{closed && owner?.key === actor && (
													<button type="button" className="button small" onClick={() => onReopenModal(key)}>
														Reopen
													</button>
												)}
											</li>
										);
									})}
								</ul>
							) : (
								<p className="lab-empty">None</p>
							)}
						</section>
						<section className="lab-section">
							<h3>Collectors</h3>
							<Entries items={snapshot.pending.collectors} empty="None" />
						</section>
					</>
				)}
				{tab === 'world' && (
					<>
						<dl className="world-summary">
							{Object.entries(
								snapshot.rawInspect?.world && typeof snapshot.rawInspect.world === 'object'
									? snapshot.rawInspect.world
									: {},
							)
								.filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
								.map(([name, items]) => (
									<div key={name}>
										<dt>{name}</dt>
										<dd>{items.length}</dd>
									</div>
								))}
						</dl>
						<button type="button" className="button small" onClick={() => setWorldOpen(!worldOpen)}>
							{worldOpen ? 'Hide JSON' : 'Show JSON'}
						</button>
						{worldOpen && <Json value={snapshot.rawInspect?.world} />}
					</>
				)}
				{tab === 'diagnostics' && (
					<Entries
						items={[
							...viewDiagnostics.map(text => ({ id: `view-${text}`, label: text, detail: 'Current view' })),
							...snapshot.inspector.diagnostics,
						]}
						empty="None"
					/>
				)}
				{tab === 'project' &&
					(snapshot.project.inspectors.length ? (
						snapshot.project.inspectors.map(name => (
							<section className="lab-section" key={name}>
								<h3>{name}</h3>
								<Json value={snapshot.projections?.[name]} />
							</section>
						))
					) : (
						<p className="lab-empty">No project inspectors.</p>
					))}
				{tab === 'checkpoints' && (
					<CheckpointsTab
						snapshot={snapshot}
						client={client}
						arrival={arrival}
						onArrival={onArrival}
						actor={actor}
						channel={channel}
						status={status}
						onStatus={onStatus}
						report={report}
					/>
				)}
			</div>
		</div>
	);
}
