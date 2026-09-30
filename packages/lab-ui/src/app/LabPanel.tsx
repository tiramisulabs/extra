import { useState } from 'react';
import { type InspectorEntry, type JsonValue, type LabClient, type LabSnapshot, sessionActors } from '../bridge';
import { shortRevision } from '../format';
import { type CheckpointDraft, CheckpointsTab } from './CheckpointsTab';
import { ScenarioForm, type ScenarioLauncher } from './ScenarioForm';

const LAB_TABS = [
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

function Entries({ items, empty }: { items: InspectorEntry[]; empty: string }) {
	if (!items.length) return <p className="lab-empty">{empty}</p>;
	return (
		<ol className="lab-entries">
			{items.map(item => (
				<li key={item.id} className={item.failed ? 'failed' : ''}>
					<div className="entry-head">
						{item.kind && <span className={`kind-badge ${item.kind}`}>{item.kind}</span>}
						{item.failed && <span className="kind-badge failed">failed</span>}
						<span className="entry-label">{item.label}</span>
					</div>
					{item.detail && <pre className="entry-detail">{item.detail}</pre>}
				</li>
			))}
		</ol>
	);
}

function Json({ value }: { value: JsonValue | undefined }) {
	return <pre className="json-view">{value === undefined ? '—' : JSON.stringify(value, null, 2)}</pre>;
}

/** Restart form and the session's refs; before a session the launcher in the conversation area holds the form. */
function ScenarioTab({ snapshot, launcher }: { snapshot: LabSnapshot; launcher: ScenarioLauncher }) {
	const { session } = snapshot;
	if (!session) return <p className="lab-empty">Start a scenario to restart it here and see its refs.</p>;
	return (
		<>
			<ScenarioForm project={snapshot.project} launcher={launcher} running />
			<section className="lab-section">
				<h3>Refs</h3>
				<dl className="refs">
					{Object.entries(session.refs).map(([name, id]) => (
						<div key={name}>
							<dt>{name}</dt>
							<dd>
								<code>{id}</code>
							</dd>
						</div>
					))}
				</dl>
			</section>
		</>
	);
}

function PendingTab({ snapshot, client, actor }: { snapshot: LabSnapshot; client: LabClient; actor: string }) {
	return (
		<>
			<section className="lab-section">
				<h3>Modals</h3>
				{snapshot.pending.modals.length ? (
					<ul className="pending-list">
						{snapshot.pending.modals.map(modal => {
							const key = modal.interactionId;
							const owner = sessionActors(snapshot.session).find(item => item.userId === modal.userId);
							const closed = snapshot.closedModals.includes(key);
							return (
								<li key={key}>
									<strong>{modal.payload.title}</strong>
									<code>{modal.customId}</code>
									<span>
										{owner?.name ?? modal.userId}
										{closed ? ' · closed locally' : ''}
									</span>
									{closed && owner?.key === actor && (
										<button type="button" className="button small" onClick={() => client.reopenModal(key)}>
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
	);
}

/** How many entities of each kind the world holds, with the raw JSON on demand. */
function WorldTab({ world }: { world: JsonValue | undefined }) {
	const [open, setOpen] = useState(false);
	const collections =
		world && typeof world === 'object' && !Array.isArray(world)
			? Object.entries(world).filter((entry): entry is [string, JsonValue[]] => Array.isArray(entry[1]))
			: [];
	return (
		<>
			<dl className="world-summary">
				{collections.map(([name, items]) => (
					<div key={name}>
						<dt>{name}</dt>
						<dd>{items.length}</dd>
					</div>
				))}
			</dl>
			<button type="button" className="button small" onClick={() => setOpen(!open)}>
				{open ? 'Hide JSON' : 'Show JSON'}
			</button>
			{open && <Json value={world} />}
		</>
	);
}

function ProjectTab({ snapshot }: { snapshot: LabSnapshot }) {
	if (!snapshot.project.inspectors.length) return <p className="lab-empty">No project inspectors.</p>;
	return snapshot.project.inspectors.map(name => (
		<section className="lab-section" key={name}>
			<h3>{name}</h3>
			<Json value={snapshot.projections?.[name]} />
		</section>
	));
}

export function LabPanel({
	snapshot,
	client,
	tab,
	onTab,
	launcher,
	draft,
	actor,
	channel,
	report,
}: {
	snapshot: LabSnapshot;
	client: LabClient;
	tab: LabTab;
	onTab: (tab: LabTab) => void;
	launcher: ScenarioLauncher;
	draft: CheckpointDraft;
	actor: string;
	channel: string;
	report: (reason: unknown) => void;
}) {
	const { session, inspector, pending } = snapshot;
	// Engine notes for the conversation on screen; the lock screen already says the actor cannot view the channel.
	const viewDiagnostics =
		snapshot.conversations[`${actor}:${channel}`]?.diagnostics.filter(item => item !== 'no-view-channel') ?? [];
	const counts: Partial<Record<LabTab, number>> = {
		log: inspector.actions.length,
		rest: inspector.rest.filter(item => item.failed).length,
		pending: pending.modals.length + pending.collectors.length,
		diagnostics: inspector.diagnostics.length + viewDiagnostics.length,
		checkpoints: draft.arrival.length,
	};
	return (
		<div className="lab-panel">
			<header className="lab-header">
				<div>
					<strong>{snapshot.project.name}</strong>
					<small>{session ? `${session.preset.scenario.id}@${session.preset.scenario.version}` : 'No session'}</small>
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
				{tab === 'scenario' && <ScenarioTab snapshot={snapshot} launcher={launcher} />}
				{tab === 'log' && <Entries items={inspector.actions} empty="No actions yet." />}
				{tab === 'rest' && <Entries items={inspector.rest} empty="No REST calls yet." />}
				{tab === 'pending' && <PendingTab snapshot={snapshot} client={client} actor={actor} />}
				{tab === 'world' && <WorldTab world={snapshot.rawInspect?.world} />}
				{tab === 'diagnostics' && (
					<Entries
						items={[
							...viewDiagnostics.map(text => ({ id: `view-${text}`, label: text, detail: 'Current view' })),
							...inspector.diagnostics,
						]}
						empty="None"
					/>
				)}
				{tab === 'project' && <ProjectTab snapshot={snapshot} />}
				{tab === 'checkpoints' && (
					<CheckpointsTab
						snapshot={snapshot}
						client={client}
						draft={draft}
						actor={actor}
						channel={channel}
						report={report}
					/>
				)}
			</div>
		</div>
	);
}
