import { useEffect, useState } from 'react';
import type { CheckpointClient, Expectation, JsonValue, LabClient, LabSnapshot } from '../bridge';
import { hasCheckpoints } from '../bridge';
import { HostError, shortRevision } from '../HostClient';
import { CloseIcon } from '../icons';

/** The outcome of the last checkpoint operation; a replay passes or fails, anything else is neutral. */
export interface CheckpointStatus {
	text: string;
	tone?: 'ok' | 'danger';
}

export function StatusCallout({ status }: { status: CheckpointStatus }) {
	return (
		<p className={`lab-callout ${status.tone ?? ''}`} role="status">
			{status.text}
		</p>
	);
}

/** Expectations pinned for the next checkpoint, gathered from messages, members and the lab panel. */
export interface CheckpointDraft {
	arrival: Expectation[];
	setArrival: (arrival: Expectation[]) => void;
	status?: CheckpointStatus;
	setStatus: (status?: CheckpointStatus) => void;
	pin: (expectation: Expectation) => void;
	reset: () => void;
}

export function useCheckpointDraft(): CheckpointDraft {
	const [arrival, setArrival] = useState<Expectation[]>([]);
	const [status, setStatus] = useState<CheckpointStatus>();
	return {
		arrival,
		setArrival,
		status,
		setStatus,
		pin(expectation) {
			setArrival(existing => [...existing, expectation]);
			setStatus({ text: 'Expectation added. Save a checkpoint to keep it.' });
		},
		reset() {
			setArrival([]);
			setStatus(undefined);
		},
	};
}

/** Short sentence for a pinned expectation; the JSON stays visible for exactness. */
function describeExpectation(expectation: Expectation, snapshot: LabSnapshot): string {
	const names = snapshot.session?.names;
	if ('view' in expectation) {
		const actor = snapshot.actors.find(item => item.key === expectation.view.actor)?.name ?? expectation.view.actor;
		const channel = names?.channels[expectation.view.channel] ?? expectation.view.channel;
		return `${actor} ${expectation.absent ? 'does not see' : 'sees'} “${expectation.contains}” in #${channel}`;
	}
	if ('role' in expectation) {
		const role = names?.roles[expectation.role.role] ?? expectation.role.role;
		const member = names?.users[expectation.role.member] ?? expectation.role.member;
		return `${member} ${expectation.present ? 'has' : 'lacks'} role ${role}`;
	}
	if ('project' in expectation)
		return `${expectation.project.name}.${expectation.project.path} equals the pinned value`;
	if ('path' in expectation) return `${expectation.path} equals the pinned value`;
	return `Action ${expectation.action + 1} ${expectation.ok ? 'succeeds' : 'fails'}`;
}

function valueAt(value: unknown, path: string): unknown {
	if (!path) return value;
	return path
		.split('.')
		.reduce<unknown>(
			(current, key) =>
				current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
			value,
		);
}

const INSPECT_SOURCE = 'inspect';

function ExpectationsSection({
	snapshot,
	draft,
	actor,
	channel,
	report,
}: {
	snapshot: LabSnapshot;
	draft: CheckpointDraft;
	actor: string;
	channel: string;
	report: (reason: unknown) => void;
}) {
	const [absentText, setAbsentText] = useState('');
	const [source, setSource] = useState(INSPECT_SOURCE);
	const [path, setPath] = useState('');
	const { arrival, setArrival } = draft;
	function pinValue() {
		const base = source === INSPECT_SOURCE ? snapshot.rawInspect : snapshot.projections?.[source];
		const value = valueAt(base, path);
		if (value === undefined) {
			report(`No value at "${path}" in ${source}.`);
			return;
		}
		const equals = JSON.parse(JSON.stringify(value)) as JsonValue;
		setArrival([
			...arrival,
			source === INSPECT_SOURCE ? { path, equals } : { project: { name: source, path }, equals },
		]);
	}
	return (
		<section className="lab-section">
			<h3>Expectations · {arrival.length}</h3>
			{arrival.length ? (
				<ol className="expectations">
					{arrival.map((item, index) => (
						<li key={`${index}-${JSON.stringify(item)}`}>
							<span>{describeExpectation(item, snapshot)}</span>
							<code>{JSON.stringify(item)}</code>
							<button
								type="button"
								className="icon-button"
								aria-label={`Remove expectation ${index + 1}`}
								onClick={() => setArrival(arrival.filter((_, position) => position !== index))}>
								<CloseIcon size={14} />
							</button>
						</li>
					))}
				</ol>
			) : (
				<p className="lab-empty">None. Pin messages, roles or values.</p>
			)}
			<div className="inline-form">
				<label className="field" htmlFor="absent-text">
					<span className="field-label">Hidden text</span>
					<input id="absent-text" value={absentText} onChange={event => setAbsentText(event.target.value)} />
				</label>
				<button
					type="button"
					className="button small lab"
					disabled={!absentText || !actor || !channel}
					onClick={() => {
						setArrival([...arrival, { view: { actor, channel }, contains: absentText, absent: true }]);
						setAbsentText('');
					}}>
					Expect absent
				</button>
			</div>
			<div className="inline-form">
				<label className="field" htmlFor="pin-source">
					<span className="field-label">Source</span>
					<select id="pin-source" value={source} onChange={event => setSource(event.target.value)}>
						<option value={INSPECT_SOURCE}>Discord (inspect)</option>
						{snapshot.project.inspectors.map(item => (
							<option key={item} value={item}>
								{item}
							</option>
						))}
					</select>
				</label>
				<label className="field" htmlFor="pin-path">
					<span className="field-label">Path</span>
					<input
						id="pin-path"
						value={path}
						placeholder="pending.modals.0.customId"
						onChange={event => setPath(event.target.value)}
					/>
				</label>
				<button type="button" className="button small lab" onClick={pinValue}>
					Pin value
				</button>
			</div>
		</section>
	);
}

type TestFormat = 'vitest' | 'node';

function CheckpointSection({
	snapshot,
	client,
	draft,
	report,
}: {
	snapshot: LabSnapshot;
	client: CheckpointClient;
	draft: CheckpointDraft;
	report: (reason: unknown) => void;
}) {
	const [name, setName] = useState('');
	const [saved, setSaved] = useState('');
	const [names, setNames] = useState<string[]>([]);
	const [format, setFormat] = useState<TestFormat>('vitest');
	const [code, setCode] = useState('');
	const { arrival, setArrival, status, setStatus } = draft;
	useEffect(() => {
		void client.listCheckpoints().then(setNames).catch(report);
	}, [client, report]);
	// Replay and export act on the stored checkpoint, so they wait until the name on screen is the one saved.
	const ready = saved === name && names.includes(name);

	async function save() {
		try {
			await client.saveCheckpoint(name, arrival);
			setSaved(name);
			setNames(await client.listCheckpoints());
			setStatus({ text: `Saved ${name}.` });
		} catch (reason) {
			report(reason);
		}
	}
	async function load(value: string) {
		if (!value) return;
		try {
			const checkpoint = await client.loadCheckpoint(value);
			setName(value);
			setSaved(value);
			setCode('');
			setArrival(checkpoint.arrival);
			setStatus({
				text: `Loaded ${value}: ${checkpoint.actions.length} actions, ${checkpoint.arrival.length} expectations.`,
			});
		} catch (reason) {
			report(reason);
		}
	}
	async function replay(acceptRevision = false) {
		setStatus({ text: `Replaying ${name}…` });
		try {
			await client.replayCheckpoint(name, acceptRevision ? { acceptRevision } : undefined);
			setStatus({ text: `PASS · ${name}`, tone: 'ok' });
		} catch (reason) {
			if (reason instanceof HostError && reason.code === 'revision-mismatch' && !acceptRevision) {
				const { checkpointRevision = 'unknown', currentRevision = 'unknown' } = reason.details;
				const confirmed = window.confirm(
					`${name} was recorded on ${shortRevision(checkpointRevision)}; this preview is ${shortRevision(currentRevision)}. Replay anyway?`,
				);
				if (confirmed) return replay(true);
				setStatus(undefined);
				return;
			}
			setStatus({ text: `FAIL · ${reason instanceof Error ? reason.message : String(reason)}`, tone: 'danger' });
		}
	}
	async function exportTest() {
		try {
			setCode(await client.exportCheckpoint(name, format));
		} catch (reason) {
			report(reason);
		}
	}

	return (
		<section className="lab-section">
			<h3>Checkpoint</h3>
			<div className="inline-form">
				<label className="field" htmlFor="checkpoint-name">
					<span className="field-label">Name</span>
					<input
						id="checkpoint-name"
						value={name}
						placeholder="my_checkpoint"
						onChange={event => setName(event.target.value)}
					/>
				</label>
				<button
					type="button"
					className="button small primary"
					disabled={!name || !snapshot.log}
					onClick={() => void save()}>
					Save
				</button>
			</div>
			<label className="field" htmlFor="checkpoint-list">
				<span className="field-label">Saved</span>
				<select
					id="checkpoint-list"
					value={names.includes(name) ? name : ''}
					onChange={event => void load(event.target.value)}>
					<option value="">{names.length ? 'Choose…' : 'None'}</option>
					{names.map(item => (
						<option key={item} value={item}>
							{item}
						</option>
					))}
				</select>
			</label>
			{snapshot.host?.mode === 'hosted' && <p className="lab-empty">Kept until this run ends.</p>}
			<div className="button-row">
				<button
					type="button"
					className="button small"
					disabled={!ready}
					title="Replays in a new session; the current one ends"
					onClick={() => void replay()}>
					Replay
				</button>
				<select aria-label="Test format" value={format} onChange={event => setFormat(event.target.value as TestFormat)}>
					<option value="vitest">Vitest</option>
					<option value="node">node:test</option>
				</select>
				<button type="button" className="button small" disabled={!ready} onClick={() => void exportTest()}>
					Export test
				</button>
			</div>
			{status && <StatusCallout status={status} />}
			{code && (
				<div className="export">
					<textarea aria-label="Exported test" readOnly value={code} rows={14} />
					<button
						type="button"
						className="button small"
						onClick={() =>
							void navigator.clipboard
								.writeText(code)
								.then(() => setStatus({ text: 'Copied.' }))
								.catch(report)
						}>
						Copy
					</button>
				</div>
			)}
		</section>
	);
}

export function CheckpointsTab({
	snapshot,
	client,
	draft,
	actor,
	channel,
	report,
}: {
	snapshot: LabSnapshot;
	client: LabClient;
	draft: CheckpointDraft;
	actor: string;
	channel: string;
	report: (reason: unknown) => void;
}) {
	if (!hasCheckpoints(client)) return <p className="lab-empty">Checkpoints are not available.</p>;
	return (
		<div className="checkpoints">
			<ExpectationsSection snapshot={snapshot} draft={draft} actor={actor} channel={channel} report={report} />
			<CheckpointSection snapshot={snapshot} client={client} draft={draft} report={report} />
		</div>
	);
}
