import { type FormEvent, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { CommandOption, JsonValue, LabSnapshot } from '../bridge';
import { CloseIcon, SendIcon, SlashIcon } from './icons';

interface CommandEntry {
	key: string;
	command: string;
	group?: string;
	subcommand?: string;
	description?: string;
	options: CommandOption[];
}

const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

/** Flattens schemas into the executable leaves Discord offers in its picker: command, group + subcommand, or subcommand. */
export function commandEntries(snapshot: LabSnapshot): CommandEntry[] {
	return snapshot.commands.flatMap(command => {
		const options = command.options ?? [];
		const groups = options.filter(option => option.type === SUBCOMMAND_GROUP);
		const subcommands = options.filter(option => option.type === SUBCOMMAND);
		if (!groups.length && !subcommands.length)
			return [
				{
					key: command.name,
					command: command.name,
					description: 'description' in command ? command.description : undefined,
					options,
				},
			];
		return [
			...groups.flatMap(group =>
				(group.options ?? [])
					.filter(option => option.type === SUBCOMMAND)
					.map(leaf => ({
						key: `${command.name} ${group.name} ${leaf.name}`,
						command: command.name,
						group: group.name,
						subcommand: leaf.name,
						description: leaf.description,
						options: leaf.options ?? [],
					})),
			),
			...subcommands.map(leaf => ({
				key: `${command.name} ${leaf.name}`,
				command: command.name,
				subcommand: leaf.name,
				description: leaf.description,
				options: leaf.options ?? [],
			})),
		];
	});
}

function optionChoices(option: CommandOption, snapshot: LabSnapshot, guildId?: string) {
	const guild = snapshot.session?.guilds.find(item => item.id === guildId);
	if ('choices' in option && option.choices?.length)
		return option.choices.map(choice => ({ label: choice.name, value: String(choice.value) }));
	if (option.type === 5)
		return [
			{ label: 'True', value: 'true' },
			{ label: 'False', value: 'false' },
		];
	const members = guild?.members.map(member => ({ label: `@${member.name}`, value: member.id })) ?? [];
	const roles =
		guild?.roles.filter(role => role.id !== guild.id).map(role => ({ label: `@${role.name}`, value: role.id })) ?? [];
	if (option.type === 6) return members;
	if (option.type === 8) return roles;
	if (option.type === 9) return [...members, ...roles];
	if (option.type === 7)
		return guild?.channels.map(channel => ({ label: `#${channel.name}`, value: channel.id })) ?? [];
	return undefined;
}

function OptionPill({
	option,
	value,
	onChange,
	snapshot,
	guildId,
}: {
	option: CommandOption;
	value: JsonValue | undefined;
	onChange: (value: JsonValue | undefined) => void;
	snapshot: LabSnapshot;
	guildId?: string;
}) {
	const id = `option-${option.name}`;
	const choices = optionChoices(option, snapshot, guildId);
	const numeric = option.type === 4 || option.type === 10;
	if (option.type === 11)
		return (
			<span className="option-pill unsupported" title="Attachments are not simulated">
				{option.name}: unsupported attachment
			</span>
		);
	return (
		<label className={`option-pill ${option.required ? 'required' : ''}`} htmlFor={id} title={option.description}>
			<span>{option.name}</span>
			{choices ? (
				<select
					id={id}
					required={option.required}
					value={value === undefined ? '' : String(value)}
					onChange={event => {
						const raw = event.target.value;
						if (!raw) onChange(undefined);
						else if (option.type === 5) onChange(raw === 'true');
						else onChange(numeric ? Number(raw) : raw);
					}}>
					<option value="">{choices.length ? 'Choose' : 'No options'}</option>
					{choices.map(choice => (
						<option key={choice.value} value={choice.value}>
							{choice.label}
						</option>
					))}
				</select>
			) : (
				<input
					id={id}
					type={numeric ? 'number' : 'text'}
					step={option.type === 10 ? 'any' : undefined}
					required={option.required}
					placeholder={option.description}
					value={value === undefined ? '' : String(value)}
					onChange={event => {
						const raw = event.target.value;
						onChange(raw === '' ? undefined : numeric ? Number(raw) : raw);
					}}
				/>
			)}
		</label>
	);
}

export function Composer({
	snapshot,
	channelName,
	guildId,
	canView,
	onRun,
}: {
	snapshot: LabSnapshot;
	channelName: string;
	guildId?: string;
	canView: boolean;
	onRun: (entry: { command: string; group?: string; subcommand?: string; options: Record<string, JsonValue> }) => void;
}) {
	const entries = useMemo(() => commandEntries(snapshot), [snapshot]);
	const [query, setQuery] = useState('');
	const [picking, setPicking] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [selected, setSelected] = useState<CommandEntry>();
	const [values, setValues] = useState<Record<string, JsonValue | undefined>>({});
	const input = useRef<HTMLInputElement>(null);
	const search = query.replace(/^\//, '').trim().toLowerCase();
	const matches = entries.filter(entry => entry.key.includes(search));
	const current = selected && entries.find(entry => entry.key === selected.key);

	function choose(entry: CommandEntry) {
		setSelected(entry);
		setValues({});
		setQuery('');
		setPicking(false);
	}
	function clear() {
		setSelected(undefined);
		setValues({});
		setQuery('');
		input.current?.focus();
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!current) {
			const first = matches[highlight] ?? matches[0];
			if (first) choose(first);
			return;
		}
		const options: Record<string, JsonValue> = {};
		for (const [name, value] of Object.entries(values)) if (value !== undefined) options[name] = value;
		onRun({ command: current.command, group: current.group, subcommand: current.subcommand, options });
		clear();
	}
	function navigate(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === 'Escape') {
			setPicking(false);
			if (!query && current) clear();
		}
		if (!picking || !matches.length) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setHighlight(index => (index + 1) % matches.length);
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setHighlight(index => (index - 1 + matches.length) % matches.length);
		}
	}

	if (!canView)
		return (
			<div className="composer locked" role="note">
				You do not have permission to send messages in this channel.
			</div>
		);
	const missing = current?.options.filter(option => option.required && values[option.name] === undefined) ?? [];
	return (
		<form className="composer" onSubmit={submit}>
			{picking && !current && (
				<div className="command-picker" role="listbox" id="command-picker" aria-label="Commands">
					<div className="picker-heading">{snapshot.project.name}</div>
					{matches.length ? (
						matches.map((entry, index) => (
							<button
								type="button"
								role="option"
								aria-selected={index === highlight}
								key={entry.key}
								className={index === highlight ? 'highlight' : ''}
								onMouseEnter={() => setHighlight(index)}
								onMouseDown={event => event.preventDefault()}
								onClick={() => choose(entry)}>
								<strong>/{entry.key}</strong>
								<span>{entry.description}</span>
							</button>
						))
					) : (
						<p className="picker-empty">{entries.length ? 'No matching commands' : 'No commands'}</p>
					)}
				</div>
			)}
			<div className="composer-box">
				<SlashIcon />
				{current ? (
					<div className="command-draft">
						<span className="command-chip">
							/{current.key}
							<button type="button" aria-label="Clear command" onClick={clear}>
								<CloseIcon size={12} />
							</button>
						</span>
						{current.options.map(option => (
							<OptionPill
								key={option.name}
								option={option}
								value={values[option.name]}
								snapshot={snapshot}
								guildId={guildId}
								onChange={value => setValues(existing => ({ ...existing, [option.name]: value }))}
							/>
						))}
					</div>
				) : (
					<input
						ref={input}
						aria-label="Command"
						aria-controls="command-picker"
						aria-expanded={picking}
						placeholder={`Run a command in #${channelName}`}
						value={query}
						onFocus={() => setPicking(true)}
						onBlur={() => setPicking(false)}
						onKeyDown={navigate}
						onChange={event => {
							setQuery(event.target.value);
							setHighlight(0);
							setPicking(true);
						}}
					/>
				)}
				<button
					type="submit"
					className="send-button"
					aria-label={current ? `Run /${current.key}` : 'Choose command'}
					disabled={current ? missing.length > 0 : !matches.length}>
					<SendIcon />
				</button>
			</div>
			{current && missing.length > 0 && (
				<p className="composer-hint">Required: {missing.map(option => option.name).join(', ')}</p>
			)}
		</form>
	);
}
