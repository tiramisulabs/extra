import { PermissionFlagsBits } from 'seyfert/lib/types';
import { mockId } from '../id';
import {
	type ApiAttachment,
	type ApiChannel,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiUser,
	apiAttachment,
	apiChannel,
	apiMember,
	apiMessage,
	apiUser,
} from './payloads';

/** Discord ApplicationCommandOptionType values used by the encoder. */
const OptionType = {
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

/**
 * Permissive default for app_permissions / member.permissions: every
 * permission bit the installed seyfert knows, ORed together.
 */
export const DEFAULT_PERMISSIONS = Object.values(PermissionFlagsBits)
	.reduce((bits, bit) => bits | bit, 0n)
	.toString();

export interface EncodedOption {
	__slipherOption: true;
	type: number;
	value: string | number | boolean;
	resolved?: {
		users?: Record<string, unknown>;
		members?: Record<string, unknown>;
		channels?: Record<string, unknown>;
		roles?: Record<string, unknown>;
		attachments?: Record<string, unknown>;
	};
}

export type OptionInput = string | number | boolean | EncodedOption;

export function rawOption(type: number, value: string | number | boolean): EncodedOption {
	return { __slipherOption: true, type, value };
}

export function userOption(user: ApiUser = apiUser(), member?: Omit<ApiMember, 'user'>): EncodedOption {
	return {
		__slipherOption: true,
		type: OptionType.User,
		value: user.id,
		resolved: {
			users: { [user.id]: user },
			...(member ? { members: { [user.id]: { permissions: DEFAULT_PERMISSIONS, ...member } } } : {}),
		},
	};
}

export function channelOption(channel: ApiChannel = apiChannel()): EncodedOption {
	return {
		__slipherOption: true,
		type: OptionType.Channel,
		value: channel.id,
		resolved: { channels: { [channel.id]: { ...channel, permissions: DEFAULT_PERMISSIONS } } },
	};
}

export function roleOption(role: { id: string; name: string }): EncodedOption {
	return {
		__slipherOption: true,
		type: OptionType.Role,
		value: role.id,
		resolved: { roles: { [role.id]: role } },
	};
}

/** A user or a role. Pass the entity object. */
export function mentionableOption(entity: ApiUser | { id: string; name: string }): EncodedOption {
	const isUser = 'username' in entity;
	return {
		__slipherOption: true,
		type: OptionType.Mentionable,
		value: entity.id,
		resolved: isUser ? { users: { [entity.id]: entity } } : { roles: { [entity.id]: entity } },
	};
}

export function attachmentOption(attachment: ApiAttachment = apiAttachment()): EncodedOption {
	return {
		__slipherOption: true,
		type: OptionType.Attachment,
		value: attachment.id,
		resolved: { attachments: { [attachment.id]: attachment } },
	};
}

interface ApiCommandDataOption {
	name: string;
	type: number;
	value?: string | number | boolean;
	options?: ApiCommandDataOption[];
}

interface ResolvedData {
	users?: Record<string, unknown>;
	members?: Record<string, unknown>;
	channels?: Record<string, unknown>;
	roles?: Record<string, unknown>;
	attachments?: Record<string, unknown>;
}

function isEncodedOption(value: OptionInput): value is EncodedOption {
	return typeof value === 'object' && value !== null && '__slipherOption' in value;
}

function encodeOptions(options: Record<string, OptionInput>): {
	options: ApiCommandDataOption[];
	resolved: ResolvedData;
} {
	const encoded: ApiCommandDataOption[] = [];
	const resolved: ResolvedData = {};

	for (const [name, value] of Object.entries(options)) {
		if (isEncodedOption(value)) {
			encoded.push({ name, type: value.type, value: value.value });
			for (const key of ['users', 'members', 'channels', 'roles', 'attachments'] as const) {
				const entries = value.resolved?.[key];
				if (entries) resolved[key] = { ...resolved[key], ...entries };
			}
			continue;
		}

		if (typeof value === 'string') {
			encoded.push({ name, type: OptionType.String, value });
		} else if (typeof value === 'boolean') {
			encoded.push({ name, type: OptionType.Boolean, value });
		} else if (Number.isInteger(value)) {
			encoded.push({ name, type: OptionType.Integer, value });
		} else {
			encoded.push({ name, type: OptionType.Number, value });
		}
	}

	return { options: encoded, resolved };
}

export interface BaseInteractionOptions {
	user?: ApiUser;
	member?: Omit<ApiMemberOptions, 'user'>;
	/** Pass null for a DM interaction with no guild and no member. */
	guildId?: string | null;
	channel?: ApiChannel;
	locale?: string;
	applicationId?: string;
	permissions?: string;
	/** Discord interaction context: 0 = guild, 1 = bot DM, 2 = private channel. Defaults from guildId. */
	context?: number;
	integrationOwners?: Record<string, string>;
}

export interface ChatInputInteractionOptions extends BaseInteractionOptions {
	name: string;
	group?: string;
	subcommand?: string;
	options?: Record<string, OptionInput>;
}

export interface ApiInteractionPayload {
	id: string;
	application_id: string;
	type: number;
	token: string;
	version: 1;
	locale: string;
	guild_locale?: string;
	guild_id?: string;
	channel: ApiChannel;
	channel_id: string;
	member?: ApiMember;
	user?: ApiUser;
	app_permissions: string;
	attachment_size_limit: number;
	entitlements: never[];
	authorizing_integration_owners: Record<string, string>;
	context: number;
	data: {
		id?: string;
		name?: string;
		type?: number;
		custom_id?: string;
		component_type?: number;
		options?: ApiCommandDataOption[];
		resolved?: ResolvedData;
		components?: { type: 1; components: { type: 4; custom_id: string; value: string }[] }[];
	};
	message?: ApiMessage;
}

function baseInteraction(options: BaseInteractionOptions, type: number): ApiInteractionPayload {
	const id = mockId();
	const user = options.user ?? apiUser();
	const dm = options.guildId === null;
	const guildId = dm ? undefined : (options.guildId ?? mockId());
	const channel = options.channel ?? apiChannel({ guildId: guildId ?? null });
	const permissions = options.permissions ?? DEFAULT_PERMISSIONS;
	const member = dm ? undefined : { ...apiMember({ user, permissions, ...(options.member ?? {}) }), user };

	return {
		id,
		application_id: options.applicationId ?? 'slipher-test-application',
		type,
		token: `slipher-mock-interaction-token-${id}`,
		version: 1,
		attachment_size_limit: 26214400,
		locale: options.locale ?? 'en-US',
		...(dm ? {} : { guild_locale: 'en-US', guild_id: guildId }),
		channel,
		channel_id: channel.id,
		...(dm ? { user } : { member }),
		app_permissions: permissions,
		entitlements: [],
		authorizing_integration_owners: options.integrationOwners ?? {},
		context: options.context ?? (dm ? 1 : 0),
		data: {},
	};
}

export function chatInputInteraction(options: ChatInputInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 2);
	const { options: encoded, resolved } = encodeOptions(options.options ?? {});

	let dataOptions = encoded;
	if (options.subcommand) {
		dataOptions = [{ name: options.subcommand, type: OptionType.SubCommand, options: dataOptions }];
	}
	if (options.group) {
		if (!options.subcommand) throw new TypeError('chatInputInteraction: "group" requires "subcommand"');
		dataOptions = [{ name: options.group, type: OptionType.SubCommandGroup, options: dataOptions }];
	}

	payload.data = {
		id: mockId(),
		name: options.name,
		type: 1,
		options: dataOptions,
		...(Object.keys(resolved).length > 0 ? { resolved } : {}),
	};
	return payload;
}

export interface ButtonInteractionOptions extends BaseInteractionOptions {
	customId: string;
	message?: ApiMessage;
}

export function buttonInteraction(options: ButtonInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 3);
	payload.data = { custom_id: options.customId, component_type: 2 };
	payload.message =
		options.message ??
		apiMessage({
			channelId: payload.channel_id,
			...(payload.guild_id === undefined ? {} : { guildId: payload.guild_id }),
		});
	return payload;
}

export interface ModalSubmitInteractionOptions extends BaseInteractionOptions {
	customId: string;
	/** TextInput values keyed by their custom_id. */
	fields?: Record<string, string>;
}

export function modalSubmitInteraction(options: ModalSubmitInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 5);
	payload.data = {
		custom_id: options.customId,
		components: Object.entries(options.fields ?? {}).map(([customId, value]) => ({
			type: 1 as const,
			components: [{ type: 4 as const, custom_id: customId, value }],
		})),
	};
	return payload;
}
