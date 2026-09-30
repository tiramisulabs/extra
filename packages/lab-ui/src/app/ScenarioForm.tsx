import type { FormEvent } from 'react';
import type { JsonValue, LabSnapshot } from '../bridge';

type Scenario = LabSnapshot['project']['scenarios'][number];
type Parameter = Scenario['params'][string];

export interface ScenarioChoice {
	scenarioId: string;
	params: Record<string, JsonValue>;
	services: Record<string, string>;
}

export function defaultChoice(snapshot: LabSnapshot): ScenarioChoice {
	const scenario =
		snapshot.project.scenarios.find(item => item.id === snapshot.scenarioId) ?? snapshot.project.scenarios[0];
	return {
		scenarioId: scenario?.id ?? '',
		params: { ...defaultParams(scenario), ...snapshot.params },
		services: Object.fromEntries(
			Object.entries(snapshot.project.services).map(([name, service]) => [
				name,
				snapshot.session?.preset.services?.[name] ?? service.default,
			]),
		),
	};
}

function defaultParams(scenario: Scenario | undefined): Record<string, JsonValue> {
	return Object.fromEntries(Object.entries(scenario?.params ?? {}).map(([name, value]) => [name, value.default]));
}

function ParameterField({
	name,
	definition,
	value,
	onChange,
}: {
	name: string;
	definition: Parameter;
	value: JsonValue;
	onChange: (value: JsonValue) => void;
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
					onChange={event => {
						const raw = event.target.value;
						// An empty number field falls back to the default when the session starts.
						onChange(definition.kind === 'number' ? (raw === '' ? null : Number(raw)) : raw);
					}}
				/>
			)}
		</label>
	);
}

export function ScenarioForm({
	snapshot,
	choice,
	onChange,
	onStart,
	running,
	busy = false,
}: {
	snapshot: LabSnapshot;
	choice: ScenarioChoice;
	onChange: (choice: ScenarioChoice) => void;
	onStart: () => void;
	running: boolean;
	busy?: boolean;
}) {
	const scenario = snapshot.project.scenarios.find(item => item.id === choice.scenarioId);
	const services = Object.entries(snapshot.project.services);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		onStart();
	}
	return (
		<form className="scenario-form" onSubmit={submit}>
			<fieldset className="scenario-list">
				<legend>Scenario</legend>
				{snapshot.project.scenarios.map(item => (
					<label key={item.id} className={`scenario-card ${item.id === choice.scenarioId ? 'selected' : ''}`}>
						<input
							type="radio"
							name="scenario"
							value={item.id}
							checked={item.id === choice.scenarioId}
							onChange={() => onChange({ ...choice, scenarioId: item.id, params: defaultParams(item) })}
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
							onChange={value => onChange({ ...choice, params: { ...choice.params, [name]: value } })}
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
									onChange({ ...choice, services: { ...choice.services, [name]: event.target.value } })
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
			<button type="submit" className="button primary" disabled={!scenario || busy} aria-busy={busy}>
				{busy ? 'Starting…' : running ? 'Restart' : 'Start'}
			</button>
		</form>
	);
}
