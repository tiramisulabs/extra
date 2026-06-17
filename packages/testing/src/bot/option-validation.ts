import { ApplicationCommandType } from 'seyfert';
import { ApplicationCommandOptionType } from 'seyfert/lib/types';
import type {
	AutocompleteInteractionOptions,
	ChatInputInteractionOptions,
	OptionInput,
	OptionInputBag,
} from './interactions';

/** Discord application-command option types, single-sourced from seyfert's enum. */
export const CommandOptionType = ApplicationCommandOptionType;

export interface CommandOptionDefinition {
	name: string;
	type: number;
	/** Set on a SubCommand instance when it belongs to a group; seyfert keys group membership here, not via a nested type-2 option. */
	group?: string;
	required?: boolean;
	choices?: { name: string; value: string | number }[];
	min_value?: number;
	max_value?: number;
	min_length?: number;
	max_length?: number;
	channel_types?: number[];
	options?: CommandOptionDefinition[];
	autocomplete?: unknown;
}

export interface CommandWithOptions {
	name: string;
	type: ApplicationCommandType;
	options?: CommandOptionDefinition[];
}

interface EncodedOptionLike {
	__slipherOption: true;
	type: number;
	value: string | number | boolean;
	resolved?: {
		channels?: Record<string, { type?: number }>;
		users?: Record<string, unknown>;
		members?: Record<string, unknown>;
		roles?: Record<string, unknown>;
		attachments?: Record<string, unknown>;
	};
}

function isEncodedOption(value: OptionInput): value is EncodedOptionLike {
	return typeof value === 'object' && value !== null && '__slipherOption' in value;
}

function optionEntries(options: OptionInputBag | undefined): [string, OptionInput][] {
	if (!options) return [];
	return Array.isArray(options) ? options.map(option => [option.name, option.value]) : Object.entries(options);
}

function assertUniqueOptionNames(options: OptionInputBag | undefined, verb: string, commandName: string): void {
	if (!Array.isArray(options)) return;
	const seen = new Set<string>();
	for (const option of options) {
		if (seen.has(option.name)) {
			throw new TypeError(`${verb}: option "${option.name}" is provided more than once on command "${commandName}".`);
		}
		seen.add(option.name);
	}
}

/** The shape this module needs from a registered command list (`client.commands.values`). */
export type CommandList = readonly { name: string; type: unknown }[];

function chatCommand(commands: CommandList, name: string): CommandWithOptions | undefined {
	return commands.find(command => command.type === ApplicationCommandType.ChatInput && command.name === name) as
		| CommandWithOptions
		| undefined;
}

// seyfert stores subcommands flat on `command.options`, each carrying `.group` for its group; the type-2
// SubcommandGroup wrapper only exists in the wire payload, never in the registered command metadata.
function subcommandsOf(commands: CommandList, name: string): CommandOptionDefinition[] {
	return (chatCommand(commands, name)?.options ?? []).filter(option => option.type === CommandOptionType.Subcommand);
}

export function optionDefinitionsFor(
	commands: CommandList,
	options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>,
): CommandOptionDefinition[] {
	let definitions = chatCommand(commands, options.name)?.options ?? [];
	if (options.subcommand) {
		const sub = subcommandsOf(commands, options.name).find(
			option => option.name === options.subcommand && (options.group ? option.group === options.group : !option.group),
		);
		definitions = sub?.options ?? [];
	}
	return definitions.filter(
		option => option.type !== CommandOptionType.Subcommand && option.type !== CommandOptionType.SubcommandGroup,
	);
}

function assertSubcommandTarget(
	commands: CommandList,
	options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>,
	verb = 'slash',
): void {
	const subcommands = subcommandsOf(commands, options.name);
	if (!options.group && !options.subcommand) {
		if (subcommands.length > 0) {
			throw new TypeError(`${verb}: command "${options.name}" requires a subcommand.`);
		}
		return;
	}
	if (options.group && !subcommands.some(sub => sub.group === options.group)) {
		throw new TypeError(`${verb}: subcommand group "${options.group}" is not registered on "${options.name}".`);
	}
	if (!options.subcommand) {
		throw new TypeError(`${verb}: subcommand group "${options.group}" on "${options.name}" requires a subcommand.`);
	}
	const found = subcommands.some(
		sub => sub.name === options.subcommand && (options.group ? sub.group === options.group : !sub.group),
	);
	if (!found) {
		const where = options.group ? `group "${options.group}"` : `"${options.name}"`;
		throw new TypeError(`${verb}: subcommand "${options.subcommand}" is not registered on ${where}.`);
	}
}

export function optionTypesFor(definitions: CommandOptionDefinition[]): Record<string, number> {
	return Object.fromEntries(definitions.map(option => [option.name, option.type]));
}

function requireEncodedOption(name: string, input: OptionInput, expectedType: number, helper: string, verb = 'slash') {
	if (!isEncodedOption(input) || input.type !== expectedType) {
		throw new TypeError(`${verb}: option "${name}" must be provided with ${helper} when validateOptions is enabled.`);
	}
	return input;
}

function requireResolvedEntry(
	name: string,
	input: EncodedOptionLike,
	key: 'users' | 'members' | 'channels' | 'roles' | 'attachments',
	verb = 'slash',
): void {
	const value = String(input.value);
	if (!input.resolved?.[key]?.[value]) {
		throw new TypeError(`${verb}: option "${name}" is missing resolved.${key}["${value}"].`);
	}
}

function validateChatInputOptions(
	options: Pick<ChatInputInteractionOptions, 'name' | 'options'>,
	definitions: CommandOptionDefinition[],
	verb = 'slash',
	requireRequired = true,
): void {
	assertUniqueOptionNames(options.options, verb, options.name);
	const entries = new Map(optionEntries(options.options));
	const declared = new Set(definitions.map(definition => definition.name));
	for (const name of entries.keys()) {
		if (!declared.has(name)) {
			throw new TypeError(`${verb}: option "${name}" is not declared on command "${options.name}".`);
		}
	}
	for (const definition of definitions) {
		const input = entries.get(definition.name);
		if (input === undefined) {
			if (requireRequired && definition.required)
				throw new TypeError(`${verb}: option "${definition.name}" is required.`);
			continue;
		}

		const actualType = isEncodedOption(input) ? input.type : undefined;
		const value = isEncodedOption(input) ? input.value : input;
		if (actualType !== undefined && actualType !== definition.type) {
			throw new TypeError(`${verb}: option "${definition.name}" has type ${actualType}, expected ${definition.type}.`);
		}
		if (definition.choices?.length && !definition.choices.some(choice => Object.is(choice.value, value))) {
			throw new TypeError(
				`${verb}: option "${definition.name}" must be one of: ${definition.choices
					.map(choice => String(choice.value))
					.join(', ')}.`,
			);
		}

		if (definition.type === CommandOptionType.String) {
			if (typeof value !== 'string') throw new TypeError(`${verb}: option "${definition.name}" must be a string.`);
			if (definition.min_length !== undefined && value.length < definition.min_length) {
				throw new TypeError(`${verb}: option "${definition.name}" is shorter than ${definition.min_length}.`);
			}
			if (definition.max_length !== undefined && value.length > definition.max_length) {
				throw new TypeError(`${verb}: option "${definition.name}" is longer than ${definition.max_length}.`);
			}
			continue;
		}

		if (definition.type === CommandOptionType.Integer || definition.type === CommandOptionType.Number) {
			if (typeof value !== 'number') throw new TypeError(`${verb}: option "${definition.name}" must be a number.`);
			if (!Number.isFinite(value)) {
				throw new TypeError(`${verb}: option "${definition.name}" must be a finite number.`);
			}
			if (definition.type === CommandOptionType.Integer && !Number.isSafeInteger(value)) {
				throw new TypeError(`${verb}: option "${definition.name}" must be a safe integer.`);
			}
			if (definition.min_value !== undefined && value < definition.min_value) {
				throw new TypeError(`${verb}: option "${definition.name}" is less than ${definition.min_value}.`);
			}
			if (definition.max_value !== undefined && value > definition.max_value) {
				throw new TypeError(`${verb}: option "${definition.name}" is greater than ${definition.max_value}.`);
			}
			continue;
		}

		if (definition.type === CommandOptionType.Boolean) {
			if (typeof value !== 'boolean') throw new TypeError(`${verb}: option "${definition.name}" must be a boolean.`);
			continue;
		}

		if (definition.type === CommandOptionType.User) {
			const encoded = requireEncodedOption(definition.name, input, definition.type, 'userOption(...)', verb);
			requireResolvedEntry(definition.name, encoded, 'users', verb);
			continue;
		}

		if (definition.type === CommandOptionType.Role) {
			const encoded = requireEncodedOption(definition.name, input, definition.type, 'roleOption(...)', verb);
			requireResolvedEntry(definition.name, encoded, 'roles', verb);
			continue;
		}

		if (definition.type === CommandOptionType.Mentionable) {
			const encoded = requireEncodedOption(definition.name, input, definition.type, 'mentionableOption(...)', verb);
			const valueKey = String(encoded.value);
			if (!encoded.resolved?.users?.[valueKey] && !encoded.resolved?.roles?.[valueKey]) {
				throw new TypeError(`${verb}: option "${definition.name}" is missing resolved user or role "${valueKey}".`);
			}
			continue;
		}

		if (definition.type === CommandOptionType.Channel) {
			const encoded = requireEncodedOption(definition.name, input, definition.type, 'channelOption(...)', verb);
			requireResolvedEntry(definition.name, encoded, 'channels', verb);
			const channel = encoded.resolved?.channels?.[String(encoded.value)];
			if (definition.channel_types?.length) {
				if (typeof channel?.type !== 'number') {
					throw new TypeError(`${verb}: option "${definition.name}" resolved channel is missing a numeric type.`);
				}
				if (!definition.channel_types.includes(channel.type)) {
					throw new TypeError(
						`${verb}: option "${definition.name}" channel type ${channel.type} is not allowed. ` +
							`Allowed: ${definition.channel_types.join(', ')}.`,
					);
				}
			}
			continue;
		}

		if (definition.type === CommandOptionType.Attachment) {
			const encoded = requireEncodedOption(definition.name, input, definition.type, 'attachmentOption(...)', verb);
			requireResolvedEntry(definition.name, encoded, 'attachments', verb);
			continue;
		}
	}
}

export function prepareChatInputOptions(
	commands: CommandList,
	options: ChatInputInteractionOptions,
	validate: boolean,
): ChatInputInteractionOptions {
	assertSubcommandTarget(commands, options, 'slash');
	const definitions = optionDefinitionsFor(commands, options);
	if (validate) validateChatInputOptions(options, definitions);
	return {
		...options,
		optionTypes: {
			...(options.optionTypes ?? {}),
			...optionTypesFor(definitions),
		},
	};
}

export function prepareAutocompleteOptions(
	commands: CommandList,
	options: AutocompleteInteractionOptions,
	validate: boolean,
): AutocompleteInteractionOptions {
	assertSubcommandTarget(commands, options, 'autocomplete');
	const definitions = optionDefinitionsFor(commands, options);
	if (validate) {
		assertUniqueOptionNames(options.options, 'autocomplete', options.name);
		const entries = new Map(optionEntries(options.options));
		if (entries.has(options.focused)) {
			throw new TypeError(
				`autocomplete: focused option "${options.focused}" must be passed with focused/value, not options.`,
			);
		}
		validateChatInputOptions(options, definitions, 'autocomplete', false);
		const focused = definitions.find(definition => definition.name === options.focused);
		if (!focused) {
			throw new TypeError(
				`autocomplete: focused option "${options.focused}" is not declared on command "${options.name}".`,
			);
		}
		if (
			focused.type !== CommandOptionType.String &&
			focused.type !== CommandOptionType.Integer &&
			focused.type !== CommandOptionType.Number
		) {
			throw new TypeError(`autocomplete: option "${options.focused}" cannot autocomplete type ${focused.type}.`);
		}
		if (!focused.autocomplete) {
			throw new TypeError(`autocomplete: option "${options.focused}" does not declare an autocomplete callback.`);
		}
		const value = options.value ?? '';
		if (focused.type === CommandOptionType.String) {
			if (typeof value !== 'string') throw new TypeError(`autocomplete: option "${options.focused}" must be a string.`);
			if (focused.min_length !== undefined && value.length < focused.min_length) {
				throw new TypeError(`autocomplete: option "${options.focused}" is shorter than ${focused.min_length}.`);
			}
			if (focused.max_length !== undefined && value.length > focused.max_length) {
				throw new TypeError(`autocomplete: option "${options.focused}" is longer than ${focused.max_length}.`);
			}
		} else {
			if (typeof value !== 'number') throw new TypeError(`autocomplete: option "${options.focused}" must be a number.`);
			if (!Number.isFinite(value)) {
				throw new TypeError(`autocomplete: option "${options.focused}" must be a finite number.`);
			}
			if (focused.type === CommandOptionType.Integer && !Number.isSafeInteger(value)) {
				throw new TypeError(`autocomplete: option "${options.focused}" must be a safe integer.`);
			}
			if (focused.min_value !== undefined && value < focused.min_value) {
				throw new TypeError(`autocomplete: option "${options.focused}" is less than ${focused.min_value}.`);
			}
			if (focused.max_value !== undefined && value > focused.max_value) {
				throw new TypeError(`autocomplete: option "${options.focused}" is greater than ${focused.max_value}.`);
			}
		}
	}
	return {
		...options,
		optionTypes: {
			...(options.optionTypes ?? {}),
			...optionTypesFor(definitions),
		},
	};
}
