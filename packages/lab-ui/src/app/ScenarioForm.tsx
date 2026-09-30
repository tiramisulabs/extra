import { type FormEvent, useState } from 'react';
import type { LabClient, LabSnapshot, ProjectDescription, ScenarioChoice } from '../bridge';

type Scenario = ProjectDescription['scenarios'][number];
type Parameter = Scenario['params'][string];
type ParamValue = ScenarioChoice['params'][string];

/** The running session's preset, or the catalogue's first scenario with its defaults. */
function defaultChoice(snapshot: LabSnapshot): ScenarioChoice {
	const preset = snapshot.session?.preset;
	const { scenarios, services } = snapshot.project;
	const scenario = scenarios.find(item => item.id === preset?.scenario.id) ?? scenarios[0];
	return {
		scenarioId: scenario?.id ?? '',
		params: { ...defaultParams(scenario), ...preset?.params },
		services: Object.fromEntries(
			Object.entries(services).map(([name, service]) => [name, preset?.services?.[name] ?? service.default]),
		),
	};
}

function defaultParams(scenario: Scenario | undefined): ScenarioChoice['params'] {
	return Object.fromEntries(Object.entries(scenario?.params ?? {}).map(([name, value]) => [name, value.default]));
}

export interface ScenarioLauncher {
	choice: ScenarioChoice;
	setChoice: (choice: ScenarioChoice) => void;
	start: () => void;
	starting: boolean;
}

/** The scenario the next Start runs; it survives sessions and only resets when the host's catalogue is replaced. */
export function useScenarioLauncher(
	client: LabClient,
	snapshot: LabSnapshot,
	{ onStarted, report }: { onStarted: () => void; report: (reason: unknown) => void },
): ScenarioLauncher {
	const [stored, setStored] = useState<{ project: ProjectDescription; choice: ScenarioChoice }>();
	const [starting, setStarting] = useState(false);
	const { project } = snapshot;
	let choice = stored?.choice;
	// A restarted or redeployed host brings its own catalogue; a choice from the old one may not exist.
	if (!choice || stored?.project !== project) {
		choice = defaultChoice(snapshot);
		setStored({ project, choice });
	}
	const current = choice;
	return {
		choice: current,
		setChoice: next => setStored({ project, choice: next }),
		starting,
		start() {
			if (starting) return;
			setStarting(true);
			void client
				.start(current)
				.then(onStarted)
				.catch(report)
				.finally(() => setStarting(false));
		},
	};
}

/** An emptied number field sends null, which Start drops so the scenario's default applies. */
function parameterValue(kind: Parameter['kind'], raw: string): ParamValue {
	if (kind !== 'number') return raw;
	return raw === '' ? null : Number(raw);
}

function ParameterField({
	name,
	definition,
	value,
	onChange,
}: {
	name: string;
	definition: Parameter;
	value: ParamValue;
	onChange: (value: ParamValue) => void;
}) {
	const id = `param-${name}`;
	const label = definition.label ?? name;
	if (definition.kind === 'boolean')
		return (
			<label className="toggle-field" htmlFor={id}>
				<input id={id} type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked)} />
				<span className="toggle-track" aria-hidden="true" />
				<span>
					{label}
					{label !== name && <code>{name}</code>}
				</span>
			</label>
		);
	return (
		<label className="field" htmlFor={id}>
			<span className="field-label">
				{label} {label !== name && <code>{name}</code>}
			</span>
			{definition.kind === 'enum' ? (
				<select id={id} value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
					{definition.values?.map(choice => (
						<option key={String(choice)} value={String(choice)}>
							{String(choice)}
						</option>
					))}
				</select>
			) : (
				<input
					id={id}
					type={definition.kind === 'number' ? 'number' : 'text'}
					value={String(value ?? '')}
					onChange={event => onChange(parameterValue(definition.kind, event.target.value))}
				/>
			)}
		</label>
	);
}

export function ScenarioForm({
	project,
	launcher,
	running,
}: {
	project: ProjectDescription;
	launcher: ScenarioLauncher;
	running: boolean;
}) {
	const { choice, setChoice, starting } = launcher;
	const scenario = project.scenarios.find(item => item.id === choice.scenarioId);
	const services = Object.entries(project.services);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		launcher.start();
	}
	let submitLabel = running ? 'Restart' : 'Start';
	if (starting) submitLabel = 'Starting…';
	return (
		<form className="scenario-form" onSubmit={submit}>
			<fieldset className="scenario-list">
				<legend>Scenario</legend>
				{project.scenarios.map(item => (
					<label key={item.id} className={`scenario-card ${item.id === choice.scenarioId ? 'selected' : ''}`}>
						<input
							type="radio"
							name="scenario"
							value={item.id}
							checked={item.id === choice.scenarioId}
							onChange={() => setChoice({ ...choice, scenarioId: item.id, params: defaultParams(item) })}
						/>
						<strong>{item.title}</strong>
						<code>
							{item.id}@{item.version}
						</code>
					</label>
				))}
			</fieldset>
			{scenario && Object.keys(scenario.params).length > 0 && (
				<fieldset>
					<legend>Parameters</legend>
					{Object.entries(scenario.params).map(([name, definition]) => (
						<ParameterField
							key={name}
							name={name}
							definition={definition}
							value={name in choice.params ? choice.params[name] : definition.default}
							onChange={value => setChoice({ ...choice, params: { ...choice.params, [name]: value } })}
						/>
					))}
				</fieldset>
			)}
			{services.length > 0 && (
				<fieldset>
					<legend>Services</legend>
					{services.map(([name, service]) => (
						<label key={name} className="field" htmlFor={`service-${name}`}>
							<span className="field-label">
								<code>{name}</code>
							</span>
							<select
								id={`service-${name}`}
								value={choice.services[name] ?? service.default}
								onChange={event =>
									setChoice({ ...choice, services: { ...choice.services, [name]: event.target.value } })
								}>
								{service.variants.map(variant => (
									<option key={variant} value={variant}>
										{variant}
										{variant === service.default ? ' (default)' : ''}
									</option>
								))}
							</select>
						</label>
					))}
				</fieldset>
			)}
			<button type="submit" className="button primary" disabled={!scenario || starting} aria-busy={starting}>
				{submitLabel}
			</button>
		</form>
	);
}
