import { type FormEvent, type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommandOption, CommandSchema, Guild, JsonValue } from '../bridge';
import { CloseIcon, SendIcon, SlashIcon } from '../icons';

/** Discord application command option types. */
const OptionType = {
	Subcommand: 1,
	SubcommandGroup: 2,
	Integer: 4,
	Boolean: 5,
	User: 6,
	Channel: 7,
	Role: 8,
	Mentionable: 9,
	Number: 10,
	Attachment: 11,
} as const;

interface CommandEntry {
	key: string;
	command: string;
	group?: string;
	subcommand?: string;
	description?: string;
	options: CommandOption[];
}

/** Flattens schemas into the executable leaves Discord offers in its picker: command, group + subcommand, or subcommand. */
function commandEntries(commands: CommandSchema[]): CommandEntry[] {
	return commands.flatMap(command => {
		const options = command.options ?? [];
		const groups = options.filter(option => option.type === OptionType.SubcommandGroup);
		const subcommands = options.filter(option => option.type === OptionType.Subcommand);
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
					.filter(option => option.type === OptionType.Subcommand)
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

/** A fixed list to pick from, when the option has one: its choices, booleans, or the guild's entities. */
function optionChoices(option: CommandOption, guild: Guild | undefined) {
	if ('choices' in option && option.choices?.length)
		return option.choices.map(choice => ({ label: choice.name, value: String(choice.value) }));
	if (option.type === OptionType.Boolean)
		return [
			{ label: 'True', value: 'true' },
			{ label: 'False', value: 'false' },
		];
	const members = guild?.members.map(member => ({ label: `@${member.name}`, value: member.id })) ?? [];
	// The @everyone role shares the guild's ID and cannot be mentioned as an option.
	const roles =
		guild?.roles.filter(role => role.id !== guild.id).map(role => ({ label: `@${role.name}`, value: role.id })) ?? [];
	if (option.type === OptionType.User) return members;
	if (option.type === OptionType.Role) return roles;
	if (option.type === OptionType.Mentionable) return [...members, ...roles];
	if (option.type === OptionType.Channel)
		return guild?.channels.map(channel => ({ label: `#${channel.name}`, value: channel.id })) ?? [];
	return undefined;
}

const isNumeric = (option: CommandOption) => option.type === OptionType.Integer || option.type === OptionType.Number;

/** A cleared field omits the option; everything else is typed the way the option declares. */
function optionValue(option: CommandOption, raw: string): JsonValue | undefined {
	if (!raw) return undefined;
	if (option.type === OptionType.Boolean) return raw === 'true';
	if (isNumeric(option)) return Number(raw);
	return raw;
}

function OptionPill({
	option,
	value,
	onChange,
	guild,
}: {
	option: CommandOption;
	value: JsonValue | undefined;
	onChange: (value: JsonValue | undefined) => void;
	/** The open channel's guild, whose members, roles and channels are the entity options' choices. */
	guild?: Guild;
}) {
	const id = `option-${option.name}`;
	const choices = optionChoices(option, guild);
	if (option.type === OptionType.Attachment)
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
					onChange={event => onChange(optionValue(option, event.target.value))}>
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
					type={isNumeric(option) ? 'number' : 'text'}
					step={option.type === OptionType.Number ? 'any' : undefined}
					required={option.required}
					placeholder={option.description}
					value={value === undefined ? '' : String(value)}
					onChange={event => onChange(optionValue(option, event.target.value))}
				/>
			)}
		</label>
	);
}

export function Composer({
	commands,
	projectName,
	channelName,
	guild,
	canView,
	onRun,
}: {
	commands: CommandSchema[];
	projectName: string;
	channelName: string;
	guild?: Guild;
	canView: boolean;
	onRun: (entry: { command: string; group?: string; subcommand?: string; options: Record<string, JsonValue> }) => void;
}) {
	const entries = useMemo(() => commandEntries(commands), [commands]);
	const [query, setQuery] = useState('');
	const [picking, setPicking] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [selectedKey, setSelectedKey] = useState<string>();
	const [values, setValues] = useState<Record<string, JsonValue | undefined>>({});
	const input = useRef<HTMLInputElement>(null);
	/** Set by `clear`: the command input returns once it replaces the cleared draft. */
	const refocus = useRef(false);
	const search = query.replace(/^\//, '').trim().toLowerCase();
	const matches = entries.filter(entry => entry.key.includes(search));
	// Resolved on every render so a schema update reaches a command already chosen.
	const current = entries.find(entry => entry.key === selectedKey);
	useLayoutEffect(() => {
		if (current || !refocus.current) return;
		refocus.current = false;
		input.current?.focus();
	}, [current]);

	function choose(entry: CommandEntry) {
		setSelectedKey(entry.key);
		setValues({});
		setQuery('');
		setPicking(false);
	}
	function clear() {
		setSelectedKey(undefined);
		setValues({});
		setQuery('');
		refocus.current = true;
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
		if (event.key === 'Escape') setPicking(false);
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
					<div className="picker-heading">{projectName}</div>
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
								guild={guild}
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
