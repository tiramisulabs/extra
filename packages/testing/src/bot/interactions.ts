import { mockId } from '../id';
import { TEST_APPLICATION_ID, TEST_CHANNEL_ID, TEST_GUILD_ID } from './constants';
import {
	type ApiAttachment,
	type ApiChannel,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiRole,
	type ApiUser,
	apiAttachment,
	apiChannel,
	apiMember,
	apiMessage,
	apiRole,
	apiUser,
} from './payloads';
import { ALL_PERMISSIONS, combineRolePermissions, type PermissionInput, permissionBits } from './permissions';

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
 * String payload default for app_permissions / member.permissions: every
 * permission bit the installed seyfert knows, ORed together.
 */
export const DEFAULT_PERMISSIONS = ALL_PERMISSIONS.toString();

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
export interface NamedOptionInput {
	name: string;
	value: OptionInput;
}
export type OptionInputBag = Record<string, OptionInput> | readonly NamedOptionInput[];

export function rawOption(type: number, value: string | number | boolean): EncodedOption {
	return { __slipherOption: true, type, value };
}

export function userOption(user: ApiUser = apiUser(), member?: Omit<ApiMember, 'user'>): EncodedOption {
	const memberPayload = member ? resolvedMember(member) : undefined;
	return {
		__slipherOption: true,
		type: OptionType.User,
		value: user.id,
		resolved: {
			users: { [user.id]: user },
			...(memberPayload ? { members: { [user.id]: memberPayload } } : {}),
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

function resolvedMember(member: Omit<ApiMember, 'user'> | ApiMember): Omit<ApiMember, 'user'> | ApiMember {
	const raw = member as Partial<ApiMember> & Omit<ApiMember, 'user'>;
	return {
		...raw,
		permissions: raw.permissions ?? DEFAULT_PERMISSIONS,
	};
}

function resolvedRole(role: ApiRole | { id: string; name: string }): ApiRole {
	const raw = role as Partial<ApiRole> & { id: string; name: string };
	return {
		...apiRole({ id: raw.id, name: raw.name, permissions: raw.permissions, position: raw.position }),
		...raw,
	};
}

export function roleOption(role: ApiRole | { id: string; name: string }): EncodedOption {
	const rolePayload = resolvedRole(role);
	return {
		__slipherOption: true,
		type: OptionType.Role,
		value: rolePayload.id,
		resolved: { roles: { [rolePayload.id]: rolePayload } },
	};
}

/** A user or a role. Pass the entity object. */
export function mentionableOption(entity: ApiUser | { id: string; name: string }): EncodedOption {
	const isUser = 'username' in entity;
	if (isUser) {
		return {
			__slipherOption: true,
			type: OptionType.Mentionable,
			value: entity.id,
			resolved: { users: { [entity.id]: entity } },
		};
	}
	const role = resolvedRole(entity);
	return {
		__slipherOption: true,
		type: OptionType.Mentionable,
		value: entity.id,
		resolved: { roles: { [role.id]: role } },
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
	focused?: boolean;
	options?: ApiCommandDataOption[];
}

interface ResolvedData {
	users?: Record<string, unknown>;
	members?: Record<string, unknown>;
	channels?: Record<string, unknown>;
	roles?: Record<string, unknown>;
	attachments?: Record<string, unknown>;
	messages?: Record<string, unknown>;
}

function isEncodedOption(value: OptionInput): value is EncodedOption {
	return typeof value === 'object' && value !== null && '__slipherOption' in value;
}

function optionEntries(options: OptionInputBag): [string, OptionInput][] {
	return Array.isArray(options) ? options.map(option => [option.name, option.value]) : Object.entries(options);
}

function encodeOptions(
	options: OptionInputBag,
	optionTypes: Record<string, number | undefined> = {},
): {
	options: ApiCommandDataOption[];
	resolved: ResolvedData;
} {
	const encoded: ApiCommandDataOption[] = [];
	const resolved: ResolvedData = {};

	for (const [name, value] of optionEntries(options)) {
		if (isEncodedOption(value)) {
			encoded.push({ name, type: value.type, value: value.value });
			for (const key of ['users', 'members', 'channels', 'roles', 'attachments'] as const) {
				const entries = value.resolved?.[key];
				if (entries) resolved[key] = { ...resolved[key], ...entries };
			}
			continue;
		}

		const declaredType = optionTypes[name];
		if (typeof value === 'string') {
			encoded.push({ name, type: OptionType.String, value });
		} else if (typeof value === 'boolean') {
			encoded.push({ name, type: OptionType.Boolean, value });
		} else if (declaredType === OptionType.Number || declaredType === OptionType.Integer) {
			encoded.push({ name, type: declaredType, value });
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
	guildLocale?: string;
	applicationId?: string;
	/** Bot/app permissions in the channel (app_permissions). Defaults to all. */
	permissions?: PermissionInput;
	/** Invoking member's permissions. Defaults to `permissions` (and ultimately all). */
	memberPermissions?: PermissionInput;
	/** Convenience: roles whose permissions are OR-combined into memberPermissions. */
	memberRoles?: ApiRole[];
	/** Discord interaction context: 0 = guild, 1 = bot DM, 2 = private channel. Defaults from guildId. */
	context?: number;
	integrationOwners?: Record<string, string>;
}

export interface ChatInputInteractionOptions extends BaseInteractionOptions {
	name: string;
	group?: string;
	subcommand?: string;
	options?: OptionInputBag;
	/** Declared Discord option types, usually supplied by MockBot from registered command metadata. */
	optionTypes?: Record<string, number | undefined>;
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
		target_id?: string;
		values?: string[];
		components?: (
			| { type: 1; components: { type: 4; custom_id: string; value: string }[] }
			| { type: 18; component: { type: 4; custom_id: string; value: string } }
		)[];
	};
	message?: ApiMessage;
}

function baseInteraction(options: BaseInteractionOptions, type: number): ApiInteractionPayload {
	const id = mockId();
	const user = options.user ?? apiUser();
	const dm = options.guildId === null;
	const guildId = dm ? undefined : (options.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID);
	const channel = options.channel ?? apiChannel({ id: TEST_CHANNEL_ID, guildId: guildId ?? null });
	const permissions = permissionBits(options.permissions ?? DEFAULT_PERMISSIONS);
	const memberPermissions =
		options.memberPermissions !== undefined
			? permissionBits(options.memberPermissions)
			: options.member?.permissions !== undefined
				? permissionBits(options.member.permissions)
				: options.memberRoles !== undefined
					? combineRolePermissions(options.memberRoles)
					: permissions;
	const memberRoleIds = options.memberRoles?.map(role => role.id) ?? [];
	const memberRoles = [...new Set([...(options.member?.roles ?? []), ...memberRoleIds])];
	const member = dm
		? undefined
		: {
				...apiMember({ user, ...(options.member ?? {}), permissions: memberPermissions, roles: memberRoles }),
				user,
			};

	return {
		id,
		application_id: options.applicationId ?? TEST_APPLICATION_ID,
		type,
		token: `slipher-mock-interaction-token-${id}`,
		version: 1,
		attachment_size_limit: 26214400,
		locale: options.locale ?? 'en-US',
		...(dm ? {} : { guild_locale: options.guildLocale ?? 'en-US', guild_id: guildId }),
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
	const { options: encoded, resolved } = encodeOptions(options.options ?? {}, options.optionTypes);

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

export interface AutocompleteInteractionOptions extends BaseInteractionOptions {
	name: string;
	group?: string;
	subcommand?: string;
	focused: string;
	value?: string | number;
	options?: OptionInputBag;
	optionTypes?: Record<string, number | undefined>;
}

export function autocompleteInteraction(options: AutocompleteInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 4);
	const { options: encoded, resolved } = encodeOptions(options.options ?? {}, options.optionTypes);
	const focusedType = options.optionTypes?.[options.focused];
	const focusedOption = {
		name: options.focused,
		type:
			focusedType === OptionType.Number || focusedType === OptionType.Integer
				? focusedType
				: typeof options.value === 'number'
					? OptionType.Integer
					: OptionType.String,
		value: options.value ?? '',
		focused: true,
	};
	let dataOptions = [...encoded, focusedOption];
	if (options.subcommand) {
		dataOptions = [{ name: options.subcommand, type: OptionType.SubCommand, options: dataOptions }];
	}
	if (options.group) {
		if (!options.subcommand) throw new TypeError('autocompleteInteraction: "group" requires "subcommand"');
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

export interface UserCommandInteractionOptions extends BaseInteractionOptions {
	name: string;
	target?: ApiUser;
	targetMember?: Omit<ApiMember, 'user'> | ApiMember;
}

export function userCommandInteraction(options: UserCommandInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 2);
	const target = options.target ?? apiUser();
	const targetMember = options.targetMember ? resolvedMember(options.targetMember) : undefined;
	payload.data = {
		id: mockId(),
		name: options.name,
		type: 2,
		target_id: target.id,
		resolved: {
			users: { [target.id]: target },
			...(targetMember ? { members: { [target.id]: targetMember } } : {}),
		},
	};
	return payload;
}

export interface MessageCommandInteractionOptions extends BaseInteractionOptions {
	name: string;
	target?: ApiMessage;
	/** The target message author's guild member, populated into resolved.members. */
	targetMember?: Omit<ApiMember, 'user'> | ApiMember;
}

export function messageCommandInteraction(options: MessageCommandInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 2);
	const target =
		options.target ??
		apiMessage({
			channelId: payload.channel_id,
			...(payload.guild_id === undefined ? {} : { guildId: payload.guild_id }),
		});
	const targetMember = options.targetMember ? resolvedMember(options.targetMember) : undefined;
	payload.data = {
		id: mockId(),
		name: options.name,
		type: 3,
		target_id: target.id,
		resolved: {
			messages: { [target.id]: target },
			...(targetMember ? { members: { [target.author.id]: targetMember } } : {}),
		},
	};
	return payload;
}

export interface EntryPointInteractionOptions extends BaseInteractionOptions {
	name?: string;
}

export function entryPointInteraction(options: EntryPointInteractionOptions = {}): ApiInteractionPayload {
	const payload = baseInteraction(options, 2);
	payload.data = { id: mockId(), name: options.name ?? 'launch', type: 4 };
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

export interface SelectMenuInteractionOptions extends BaseInteractionOptions {
	customId: string;
	values: string[];
	componentType?: 'string' | 'user' | 'role' | 'mentionable' | 'channel' | 3 | 5 | 6 | 7 | 8;
	message?: ApiMessage;
	resolved?: {
		users?: Record<string, unknown>;
		members?: Record<string, unknown>;
		roles?: Record<string, unknown>;
		channels?: Record<string, unknown>;
	};
}

export function selectMenuInteraction(options: SelectMenuInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 3);
	const selectTypes = { string: 3, user: 5, role: 6, mentionable: 7, channel: 8 } as const;
	const componentType =
		typeof options.componentType === 'string' ? selectTypes[options.componentType] : (options.componentType ?? 3);
	payload.data = {
		custom_id: options.customId,
		component_type: componentType,
		values: options.values,
		...(options.resolved ? { resolved: options.resolved } : {}),
	};
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
			type: 18 as const,
			component: { type: 4 as const, custom_id: customId, value },
		})),
	};
	return payload;
}
