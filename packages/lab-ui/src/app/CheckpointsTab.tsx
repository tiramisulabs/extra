import { useEffect, useState } from 'react';
import type { Expectation, JsonValue, LabClient, LabSnapshot } from '../bridge';
import { HostError, shortRevision } from '../HostClient';
import { CloseIcon } from './icons';

/** Short sentence for a pinned expectation; the JSON stays visible for exactness. */
export function describeExpectation(expectation: Expectation, snapshot: LabSnapshot): string {
	const actorName = (key: string) => snapshot.actors.find(item => item.key === key)?.name ?? key;
	const channelName = (id: string) => snapshot.session?.names.channels[id] ?? id;
	if ('view' in expectation)
		return `${actorName(expectation.view.actor)} ${expectation.absent ? 'does not see' : 'sees'} “${expectation.contains}” in #${channelName(expectation.view.channel)}`;
	if ('role' in expectation) {
		const role = snapshot.session?.names.roles[expectation.role.role] ?? expectation.role.role;
		const member = snapshot.session?.names.users[expectation.role.member] ?? expectation.role.member;
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

export function CheckpointsTab({
	snapshot,
	client,
	arrival,
	onArrival,
	actor,
	channel,
	status,
	onStatus,
	report,
}: {
	snapshot: LabSnapshot;
	client: LabClient;
	arrival: Expectation[];
	onArrival: (next: Expectation[]) => void;
	actor: string;
	channel: string;
	status: string;
	onStatus: (status: string) => void;
	report: (error: string) => void;
}) {
	const [name, setName] = useState('');
	const [saved, setSaved] = useState('');
	const [names, setNames] = useState<string[]>([]);
	const [absentText, setAbsentText] = useState('');
	const [source, setSource] = useState('inspect');
	const [path, setPath] = useState('');
	const [format, setFormat] = useState<'vitest' | 'node'>('vitest');
	const [code, setCode] = useState('');
	const supported = Boolean(client.saveCheckpoint);
	useEffect(() => {
		void client
			.listCheckpoints?.()
			.then(setNames)
			.catch(reason => report(String(reason)));
	}, [client, report]);
	if (!supported) return <p className="lab-empty">Checkpoints are not available.</p>;
	const ready = saved === name && names.includes(name);

	async function save() {
		try {
			await client.saveCheckpoint?.(name, arrival);
			setSaved(name);
			setNames((await client.listCheckpoints?.()) ?? []);
			onStatus(`Saved ${name}.`);
		} catch (reason) {
			report(String(reason));
		}
	}
	async function load(value: string) {
		if (!value) return;
		try {
			const checkpoint = await client.loadCheckpoint?.(value);
			if (!checkpoint) return;
			setName(value);
			setSaved(value);
			setCode('');
			onArrival(checkpoint.arrival);
			onStatus(`Loaded ${value}: ${checkpoint.actions.length} actions, ${checkpoint.arrival.length} expectations.`);
		} catch (reason) {
			report(String(reason));
		}
	}
	async function replay(acceptRevision = false) {
		onStatus(`Replaying ${name}…`);
		try {
			await client.replayCheckpoint?.(name, acceptRevision ? { acceptRevision } : undefined);
			onStatus(`PASS · ${name}`);
		} catch (reason) {
			if (reason instanceof HostError && reason.code === 'revision-mismatch' && !acceptRevision) {
				const { checkpointRevision = 'unknown', currentRevision = 'unknown' } = reason.details;
				if (
					window.confirm(
						`${name} was recorded on ${shortRevision(checkpointRevision)}; this preview is ${shortRevision(currentRevision)}. Replay anyway?`,
					)
				)
					return replay(true);
				onStatus('');
				return;
			}
			onStatus(`FAIL · ${reason instanceof Error ? reason.message : String(reason)}`);
		}
	}
	async function exportTest() {
		try {
			setCode((await client.exportCheckpoint?.(name, format)) ?? '');
		} catch (reason) {
			report(String(reason));
		}
	}
	function pinValue() {
		const base = source === 'inspect' ? snapshot.rawInspect : snapshot.projections?.[source];
		const value = valueAt(base, path);
		if (value === undefined) {
			report(`No value at "${path}" in ${source}.`);
			return;
		}
		const equals = JSON.parse(JSON.stringify(value)) as JsonValue;
		onArrival([...arrival, source === 'inspect' ? { path, equals } : { project: { name: source, path }, equals }]);
	}

	return (
		<div className="checkpoints">
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
									onClick={() => onArrival(arrival.filter((_, position) => position !== index))}>
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
							onArrival([...arrival, { view: { actor, channel }, contains: absentText, absent: true }]);
							setAbsentText('');
						}}>
						Expect absent
					</button>
				</div>
				<div className="inline-form">
					<label className="field" htmlFor="pin-source">
						<span className="field-label">Source</span>
						<select id="pin-source" value={source} onChange={event => setSource(event.target.value)}>
							<option value="inspect">Discord (inspect)</option>
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
					<select
						aria-label="Test format"
						value={format}
						onChange={event => setFormat(event.target.value as 'vitest' | 'node')}>
						<option value="vitest">Vitest</option>
						<option value="node">node:test</option>
					</select>
					<button type="button" className="button small" disabled={!ready} onClick={() => void exportTest()}>
						Export test
					</button>
				</div>
				{status && (
					<p
						className={`lab-callout ${status.startsWith('FAIL') ? 'danger' : status.startsWith('PASS') ? 'ok' : ''}`}
						role="status">
						{status}
					</p>
				)}
				{code && (
					<div className="export">
						<textarea aria-label="Exported test" readOnly value={code} rows={14} />
						<button
							type="button"
							className="button small"
							onClick={() =>
								void navigator.clipboard
									.writeText(code)
									.then(() => onStatus('Copied.'))
									.catch(reason => report(String(reason)))
							}>
							Copy
						</button>
					</div>
				)}
			</section>
		</div>
	);
}
