import { ApplicationCommandType } from 'seyfert';
import type { ChatInputInteractionOptions, OptionInput, OptionInputBag } from './interactions';

export const CommandOptionType = {
	SubCommand: 1,
	SubCommandGroup: 2,
	String: 3,
	Integer: 4,
	Boolean: 5,
	User: 6,
	Channel: 7,
	Role: 8,
	Mentionable: 9,
	Number: 10,
	Attachment: 11,
} as const;

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
	};
}

function isEncodedOption(value: OptionInput): value is EncodedOptionLike {
	return typeof value === 'object' && value !== null && '__slipherOption' in value;
}

function optionEntries(options: OptionInputBag | undefined): [string, OptionInput][] {
	if (!options) return [];
	return Array.isArray(options) ? options.map(option => [option.name, option.value]) : Object.entries(options);
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
	return (chatCommand(commands, name)?.options ?? []).filter(option => option.type === CommandOptionType.SubCommand);
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
		option => option.type !== CommandOptionType.SubCommand && option.type !== CommandOptionType.SubCommandGroup,
	);
}

function assertSubcommandTarget(
	commands: CommandList,
	options: Pick<ChatInputInteractionOptions, 'name' | 'group' | 'subcommand'>,
): void {
	if (!options.group && !options.subcommand) return;
	const subcommands = subcommandsOf(commands, options.name);
	if (options.group && !subcommands.some(sub => sub.group === options.group)) {
		throw new TypeError(`slash: subcommand group "${options.group}" is not registered on "${options.name}".`);
	}
	if (!options.subcommand) return;
	const found = subcommands.some(
		sub => sub.name === options.subcommand && (options.group ? sub.group === options.group : !sub.group),
	);
	if (!found) {
		const where = options.group ? `group "${options.group}"` : `"${options.name}"`;
		throw new TypeError(`slash: subcommand "${options.subcommand}" is not registered on ${where}.`);
	}
}

export function optionTypesFor(definitions: CommandOptionDefinition[]): Record<string, number> {
	return Object.fromEntries(definitions.map(option => [option.name, option.type]));
}

function validateChatInputOptions(options: ChatInputInteractionOptions, definitions: CommandOptionDefinition[]): void {
	const entries = new Map(optionEntries(options.options));
	for (const definition of definitions) {
		const input = entries.get(definition.name);
		if (input === undefined) {
			if (definition.required) throw new TypeError(`slash: option "${definition.name}" is required.`);
			continue;
		}

		const actualType = isEncodedOption(input) ? input.type : undefined;
		const value = isEncodedOption(input) ? input.value : input;
		if (actualType !== undefined && actualType !== definition.type) {
			throw new TypeError(`slash: option "${definition.name}" has type ${actualType}, expected ${definition.type}.`);
		}
		if (definition.choices?.length && !definition.choices.some(choice => Object.is(choice.value, value))) {
			throw new TypeError(
				`slash: option "${definition.name}" must be one of: ${definition.choices
					.map(choice => String(choice.value))
					.join(', ')}.`,
			);
		}

		if (definition.type === CommandOptionType.String) {
			if (typeof value !== 'string') throw new TypeError(`slash: option "${definition.name}" must be a string.`);
			if (definition.min_length !== undefined && value.length < definition.min_length) {
				throw new TypeError(`slash: option "${definition.name}" is shorter than ${definition.min_length}.`);
			}
			if (definition.max_length !== undefined && value.length > definition.max_length) {
				throw new TypeError(`slash: option "${definition.name}" is longer than ${definition.max_length}.`);
			}
			continue;
		}

		if (definition.type === CommandOptionType.Integer || definition.type === CommandOptionType.Number) {
			if (typeof value !== 'number') throw new TypeError(`slash: option "${definition.name}" must be a number.`);
			if (definition.type === CommandOptionType.Integer && !Number.isInteger(value)) {
				throw new TypeError(`slash: option "${definition.name}" must be an integer.`);
			}
			if (definition.min_value !== undefined && value < definition.min_value) {
				throw new TypeError(`slash: option "${definition.name}" is less than ${definition.min_value}.`);
			}
			if (definition.max_value !== undefined && value > definition.max_value) {
				throw new TypeError(`slash: option "${definition.name}" is greater than ${definition.max_value}.`);
			}
			continue;
		}

		if (definition.type === CommandOptionType.Channel && definition.channel_types?.length && isEncodedOption(input)) {
			const channel = input.resolved?.channels?.[String(input.value)];
			if (channel?.type !== undefined && !definition.channel_types.includes(channel.type)) {
				throw new TypeError(
					`slash: option "${definition.name}" channel type ${channel.type} is not allowed. ` +
						`Allowed: ${definition.channel_types.join(', ')}.`,
				);
			}
		}
	}
}

export function prepareChatInputOptions(
	commands: CommandList,
	options: ChatInputInteractionOptions,
	validate: boolean,
): ChatInputInteractionOptions {
	assertSubcommandTarget(commands, options);
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
