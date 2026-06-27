import { ApplicationCommandOptionType } from 'seyfert/lib/types';
import { mockId } from '../id';
import { TEST_APPLICATION_ID, TEST_CHANNEL_ID, TEST_GUILD_ID } from './constants';
import {
	type ApiAttachment,
	type ApiAttachmentOptions,
	type ApiChannel,
	type ApiChannelOptions,
	type ApiMember,
	type ApiMessage,
	type ApiRole,
	type ApiRoleOptions,
	type ApiUser,
	type ApiUserOptions,
	apiAttachment,
	apiChannel,
	apiMember,
	apiMessage,
	apiRole,
	apiUser,
	type MemberInput,
	memberOptionsFrom,
} from './payloads';
import {
	ALL_PERMISSIONS,
	combineRolePermissions,
	DEFAULT_MEMBER_PERMISSIONS,
	type PermissionInput,
	permissionBits,
} from './permissions';

/** Discord application-command option types, single-sourced from seyfert's enum. */
const OptionType = ApplicationCommandOptionType;

/**
 * String payload default for app_permissions / resolved entities: every
 * permission bit the installed seyfert knows, ORed together. Note: the invoking
 * member's permissions default to DEFAULT_MEMBER_PERMISSIONS, not this.
 */
export const DEFAULT_PERMISSIONS = ALL_PERMISSIONS.toString();

/** String payload default for the invoking member's permissions: a non-admin set. */
export const DEFAULT_MEMBER_PERMISSIONS_STRING = DEFAULT_MEMBER_PERMISSIONS.toString();

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

/**
 * A resolved entity (user/channel/role/attachment) passed directly as an option value. The matching builder
 * is applied automatically from the command's declared option type, so `{ options: { user: { id, username } } }`
 * needs no `userOption(...)` wrapper. A loose `{ id }` is completed with api* defaults; a full api object passes
 * through unchanged.
 */
export type EntityOptionInput = ApiUser | ApiChannel | ApiRole | ApiAttachment | { id: string; [key: string]: unknown };
export type OptionInput = string | number | boolean | EncodedOption | EntityOptionInput;
export interface NamedOptionInput {
	name: string;
	value: OptionInput;
}
export type OptionInputBag = Record<string, OptionInput> | readonly NamedOptionInput[];

/** The shared `EncodedOption` envelope every option builder produces. */
function option(type: number, value: string | number | boolean, resolved?: EncodedOption['resolved']): EncodedOption {
	return { __slipherOption: true, type, value, ...(resolved ? { resolved } : {}) };
}

export function rawOption(type: number, value: string | number | boolean): EncodedOption {
	return option(type, value);
}

export function userOption(user: ApiUser = apiUser(), member?: MemberInput): EncodedOption {
	const memberPayload = member ? resolvedMember(member) : undefined;
	return option(OptionType.User, user.id, {
		users: { [user.id]: user },
		...(memberPayload ? { members: { [user.id]: memberPayload } } : {}),
	});
}

export function channelOption(channel: ApiChannel = apiChannel()): EncodedOption {
	return option(OptionType.Channel, channel.id, {
		channels: { [channel.id]: { ...channel, permissions: DEFAULT_PERMISSIONS } },
	});
}

function resolvedMember(member: MemberInput): Omit<ApiMember, 'user'> {
	const { user: _user, ...wire } = apiMember(memberOptionsFrom(member));
	return {
		...wire,
		permissions: wire.permissions ?? DEFAULT_PERMISSIONS,
	};
}

export type ApiRoleInput = ApiRole | (ApiRoleOptions & { id: string });

function resolvedRole(role: ApiRoleInput): ApiRole {
	const raw = role as Partial<ApiRole> & { id: string };
	const base = apiRole({ id: raw.id, name: raw.name, permissions: raw.permissions, position: raw.position });
	return {
		...base,
		...raw,
		name: raw.name ?? base.name,
		permissions: raw.permissions ?? base.permissions,
		position: raw.position ?? base.position,
	};
}

export function roleOption(role: ApiRoleInput): EncodedOption {
	const rolePayload = resolvedRole(role);
	return option(OptionType.Role, rolePayload.id, { roles: { [rolePayload.id]: rolePayload } });
}

/** A user or a role. Pass the entity object. */
export function mentionableOption(entity: ApiUser | { id: string; name: string }): EncodedOption {
	if ('username' in entity) {
		return option(OptionType.Mentionable, entity.id, { users: { [entity.id]: entity } });
	}
	const role = resolvedRole(entity);
	return option(OptionType.Mentionable, entity.id, { roles: { [role.id]: role } });
}

export function attachmentOption(attachment: ApiAttachment = apiAttachment()): EncodedOption {
	return option(OptionType.Attachment, attachment.id, { attachments: { [attachment.id]: attachment } });
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

export function isEntityInput(value: OptionInput): value is EntityOptionInput {
	return typeof value === 'object' && value !== null && !isEncodedOption(value) && 'id' in value;
}

/**
 * Replace any plain entity object in an option bag with its coerced {@link EncodedOption}, keyed off the
 * declared option types. Runs before validation so a `{ id, username }` user option is accepted exactly like a
 * `userOption(...)` result. Non-entity option types and non-object values are left untouched.
 */
export function coerceOptionBag(
	options: OptionInputBag,
	optionTypes: Record<string, number | undefined>,
): OptionInputBag {
	const coerce = (name: string, value: OptionInput): OptionInput =>
		isEntityInput(value) ? (coerceEntityOption(optionTypes[name], value) ?? value) : value;
	return Array.isArray(options)
		? options.map(entry => ({ name: entry.name, value: coerce(entry.name, entry.value) }))
		: Object.fromEntries(Object.entries(options).map(([name, value]) => [name, coerce(name, value)]));
}

/**
 * Coerce a plain entity object passed directly as an option value into the right resolved envelope, keyed off
 * the command's declared option type. Mirrors {@link resolvedRole}'s factory+spread idiom: a loose `{ id }` is
 * completed with api* defaults while a full api object passes through unchanged. Returns undefined for
 * non-entity declared types, so the caller falls back to the scalar ladder (and its validator error).
 */
export function coerceEntityOption(
	declaredType: number | undefined,
	raw: EntityOptionInput,
): EncodedOption | undefined {
	const fullUser = () => ({ ...apiUser(raw as ApiUserOptions), ...raw }) as ApiUser;
	const fullRole = () => ({ ...apiRole(raw as ApiRoleOptions), ...raw }) as ApiRole;
	const userShaped = 'username' in raw || 'discriminator' in raw;
	switch (declaredType) {
		case OptionType.User:
			return userOption(fullUser());
		case OptionType.Channel:
			return channelOption({ ...apiChannel(raw as ApiChannelOptions), ...raw } as ApiChannel);
		case OptionType.Role:
			return roleOption(fullRole());
		case OptionType.Mentionable:
			return mentionableOption(userShaped ? fullUser() : fullRole());
		case OptionType.Attachment:
			return attachmentOption({ ...apiAttachment(raw as ApiAttachmentOptions), ...raw } as ApiAttachment);
		default:
			return undefined;
	}
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
		const declaredType = optionTypes[name];
		// Both an explicit builder result and an auto-coerced entity object resolve to an EncodedOption; merge
		// either the same way.
		if (isEncodedOption(value) || isEntityInput(value)) {
			const envelope = isEncodedOption(value) ? value : coerceEntityOption(declaredType, value);
			if (!envelope) {
				throw new TypeError(
					`Option "${name}" received an entity object, but its declared type is not a ` +
						'user/channel/role/mentionable/attachment option. Pass a scalar value instead.',
				);
			}
			encoded.push({ name, type: envelope.type, value: envelope.value });
			for (const key of ['users', 'members', 'channels', 'roles', 'attachments'] as const) {
				const entries = envelope.resolved?.[key];
				if (entries) resolved[key] = { ...resolved[key], ...entries };
			}
			continue;
		}

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
	/** Shorthand: the invoking user's id (builds the user). `user` wins if both are given. Mirrors mockComponentContext. */
	userId?: string;
	/**
	 * The invoking guild member. Accepts either a loose options bag or a full {@link ApiMember} (so
	 * `apiMember({ roles: ['r1'] })` can be passed directly, no cast). The `user` is owned by the
	 * dispatcher and ignored here.
	 */
	member?: MemberInput;
	/** Pass null for a DM interaction with no guild and no member. */
	guildId?: string | null;
	channel?: ApiChannel;
	locale?: string;
	guildLocale?: string;
	applicationId?: string;
	/** Bot/app permissions in the channel (app_permissions). Defaults to all. */
	permissions?: PermissionInput;
	/** Invoking member's permissions. Defaults to a non-admin set; pass 'all' for ALL_PERMISSIONS. */
	memberPermissions?: PermissionInput | 'all';
	/** Convenience: roles whose permissions are OR-combined into memberPermissions. Missing permissions default to "0". */
	memberRoles?: ApiRoleInput[];
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
			| { type: 18; component: { type: 19; custom_id: string; values: string[] } }
			| { type: 18; component: { type: 3 | 5 | 6 | 7 | 8; custom_id: string; values: string[] } }
		)[];
	};
	message?: ApiMessage;
}

function baseInteraction(options: BaseInteractionOptions, type: number): ApiInteractionPayload {
	const id = mockId();
	// Clone so two dispatches built from the same `user` object never share a reference (mutation leak).
	const user = { ...(options.user ?? apiUser(options.userId === undefined ? {} : { id: options.userId })) };
	const dm = options.guildId === null;
	const guildId = dm ? undefined : (options.guildId ?? options.channel?.guild_id ?? TEST_GUILD_ID);
	const channel = options.channel ?? apiChannel({ id: TEST_CHANNEL_ID, guildId: guildId ?? null });
	const permissions = permissionBits(options.permissions ?? DEFAULT_PERMISSIONS);
	const memberOptions = options.member ? memberOptionsFrom(options.member) : undefined;
	const memberRolePayloads = options.memberRoles?.map(resolvedRole);
	const memberPermissions =
		options.memberPermissions !== undefined
			? options.memberPermissions === 'all'
				? ALL_PERMISSIONS.toString()
				: permissionBits(options.memberPermissions)
			: memberOptions?.permissions !== undefined
				? permissionBits(memberOptions.permissions)
				: memberRolePayloads !== undefined
					? combineRolePermissions(memberRolePayloads)
					: DEFAULT_MEMBER_PERMISSIONS_STRING;
	const memberRoleIds = memberRolePayloads?.map(role => role.id) ?? [];
	const memberRoles = [...new Set([...(memberOptions?.roles ?? []), ...memberRoleIds])];
	const member = dm
		? undefined
		: {
				...apiMember({ user, ...(memberOptions ?? {}), permissions: memberPermissions, roles: memberRoles }),
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
		dataOptions = [{ name: options.subcommand, type: OptionType.Subcommand, options: dataOptions }];
	}
	if (options.group) {
		if (!options.subcommand) throw new TypeError('chatInputInteraction: "group" requires "subcommand"');
		dataOptions = [{ name: options.group, type: OptionType.SubcommandGroup, options: dataOptions }];
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
		dataOptions = [{ name: options.subcommand, type: OptionType.Subcommand, options: dataOptions }];
	}
	if (options.group) {
		if (!options.subcommand) throw new TypeError('autocompleteInteraction: "group" requires "subcommand"');
		dataOptions = [{ name: options.group, type: OptionType.SubcommandGroup, options: dataOptions }];
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
	/** The target user's guild member. Accepts a loose options bag or a full {@link ApiMember}. */
	targetMember?: MemberInput;
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
	/** The target message author's guild member, populated into resolved.members. Accepts a loose options bag or a full {@link ApiMember}. */
	targetMember?: MemberInput;
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

/**
 * Modal submit values keyed by input custom_id. A string fills a TextInput; an attachment array fills a
 * FileUpload input — so a command's `interaction.getFiles(customId)` (content-type validation, etc.) sees them.
 */
/** The select kinds a modal can carry; sets the submitted select's component type and what `data.resolved` holds. */
export type ModalSelectKind = 'string' | 'user' | 'role' | 'channel' | 'mentionable';

/** A select-menu submission inside a modal — produced by {@link modalSelect}, accepted as a {@link ModalFields} value. */
export interface ModalSelectField {
	readonly __modalSelect: ModalSelectKind;
	readonly values: string[];
}

/**
 * A modal field value: a string (TextInput), a `string[]` (string select — shorthand for `modalSelect(values)`), an
 * `ApiAttachment[]` (FileUpload), or a {@link modalSelect} for a user/role/channel/mentionable select.
 */
export type ModalFields = Record<string, string | string[] | ApiAttachment[] | ModalSelectField>;

const SELECT_COMPONENT_TYPE: Record<ModalSelectKind, 3 | 5 | 6 | 7 | 8> = {
	string: 3,
	user: 5,
	role: 6,
	mentionable: 7,
	channel: 8,
};

/**
 * Fill a select menu inside a modal so the handler's typed readers resolve. `getInputValue(id)` returns the raw ids
 * for any kind; the entity readers (`getUsers`/`getRoles`/`getChannels`/`getMentionables`) need the entity in
 * `data.resolved`, which this auto-builds from the ids (minimal mocks). A plain string select needs no factory — pass
 * a `string[]` as the field value directly.
 */
export function modalSelect(values: string[], kind: ModalSelectKind = 'string'): ModalSelectField {
	return { __modalSelect: kind, values };
}

function isModalSelectField(value: unknown): value is ModalSelectField {
	return typeof value === 'object' && value !== null && '__modalSelect' in value;
}

/** Populate `resolved` with minimal entities for an entity select so seyfert's getUsers/getRoles/etc. find them. */
function resolveSelectEntities(kind: ModalSelectKind, values: string[], resolved: ResolvedData): void {
	switch (kind) {
		case 'user':
		case 'mentionable':
			resolved.users ??= {};
			for (const id of values) resolved.users[id] = apiUser({ id });
			break;
		case 'role':
			resolved.roles ??= {};
			for (const id of values) resolved.roles[id] = apiRole({ id });
			break;
		case 'channel':
			resolved.channels ??= {};
			for (const id of values) resolved.channels[id] = apiChannel({ id });
			break;
	}
}

export interface ModalSubmitInteractionOptions extends BaseInteractionOptions {
	customId: string;
	fields?: ModalFields;
}

export function modalSubmitInteraction(options: ModalSubmitInteractionOptions): ApiInteractionPayload {
	const payload = baseInteraction(options, 5);
	const resolved: ResolvedData = {};
	const components = Object.entries(options.fields ?? {}).map(([customId, value]) => {
		if (isModalSelectField(value)) {
			resolveSelectEntities(value.__modalSelect, value.values, resolved);
			const type = SELECT_COMPONENT_TYPE[value.__modalSelect];
			return { type: 18 as const, component: { type, custom_id: customId, values: value.values } };
		}
		if (Array.isArray(value)) {
			// A string[] is a string select; an ApiAttachment[] is a FileUpload (objects carry an id, strings don't).
			if (value.length === 0 || typeof value[0] === 'string') {
				return { type: 18 as const, component: { type: 3 as const, custom_id: customId, values: value as string[] } };
			}
			// FileUpload (19): seyfert's getFiles reads data.resolved.attachments after finding this component.
			resolved.attachments ??= {};
			for (const file of value as ApiAttachment[]) resolved.attachments[file.id] = file;
			return {
				type: 18 as const,
				component: { type: 19 as const, custom_id: customId, values: (value as ApiAttachment[]).map(f => f.id) },
			};
		}
		return { type: 18 as const, component: { type: 4 as const, custom_id: customId, value } };
	});
	payload.data = {
		custom_id: options.customId,
		components,
		...(Object.keys(resolved).length ? { resolved } : {}),
	};
	return payload;
}
