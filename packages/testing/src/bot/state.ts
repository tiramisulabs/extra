import { mockId } from '../id';
import { TEST_BOT_ID } from './constants';
import {
	type ApiChannel,
	type ApiMessage,
	type ApiRole,
	type ApiUser,
	apiChannel,
	apiMessage,
	apiRole,
	apiUser,
} from './payloads';
import type { ChannelOverwriteLike } from './permissions';
import type { MockWorld } from './world';

export interface EmbedView {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	fields: { name: string; value: string; inline?: boolean }[];
	footer?: { text: string };
	author?: { name: string };
	image?: { url: string };
	thumbnail?: { url: string };
}

export interface ButtonView {
	customId?: string;
	label?: string;
	type: number;
	disabled?: boolean;
}

export interface MessageView {
	id: string;
	channelId: string;
	authorId?: string;
	content?: string;
	embeds: EmbedView[];
	components: unknown[];
	buttons: ButtonView[];
	button(labelOrCustomId: string): ButtonView | undefined;
}

export interface ChannelView {
	id: string;
	name?: string;
	type: number;
	parentId?: string;
	overwrites: { id: string; type: number; allow: string; deny: string }[];
	messages: MessageView[];
	lastMessage?: MessageView;
}

export interface GuildMemberView {
	userId: string;
	roles: string[];
	nick?: string | null;
	communicationDisabledUntil?: string | null;
}

export interface GuildView {
	id: string;
	name?: string;
	channels: ChannelView[];
	channel(nameOrId: string): ChannelView | undefined;
	members: GuildMemberView[];
	member(userId: string): GuildMemberView | undefined;
	role(nameOrId: string): { id: string; name: string; position: number } | undefined;
	bans: string[];
}

const EMPTY_WORLD = (): MockWorld => ({ guilds: [], channels: [], users: [], members: [], roles: [], messages: [] });

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function normalizeOverwrites(value: unknown): ChannelOverwriteLike[] {
	return arrayValue(value).map(overwrite => {
		const raw = asRecord(overwrite);
		return {
			id: stringValue(raw.id) ?? mockId(),
			type: numberValue(raw.type) ?? 0,
			allow: stringValue(raw.allow) ?? '0',
			deny: stringValue(raw.deny) ?? '0',
		};
	});
}

function normalizeEmbed(value: unknown): EmbedView {
	const raw = asRecord(value);
	const fields = arrayValue(raw.fields).map(field => {
		const entry = asRecord(field);
		return {
			name: stringValue(entry.name) ?? '',
			value: stringValue(entry.value) ?? '',
			...(typeof entry.inline === 'boolean' ? { inline: entry.inline } : {}),
		};
	});
	return {
		...(stringValue(raw.title) === undefined ? {} : { title: stringValue(raw.title) }),
		...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		...(numberValue(raw.color) === undefined ? {} : { color: numberValue(raw.color) }),
		fields,
		...(asRecord(raw.footer).text === undefined ? {} : { footer: { text: String(asRecord(raw.footer).text) } }),
		...(asRecord(raw.author).name === undefined ? {} : { author: { name: String(asRecord(raw.author).name) } }),
		...(asRecord(raw.image).url === undefined ? {} : { image: { url: String(asRecord(raw.image).url) } }),
		...(asRecord(raw.thumbnail).url === undefined ? {} : { thumbnail: { url: String(asRecord(raw.thumbnail).url) } }),
	};
}

function collectButtons(value: unknown, out: ButtonView[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) collectButtons(entry, out);
		return;
	}
	const raw = asRecord(value);
	const type = numberValue(raw.type);
	if (type !== undefined && type >= 2 && type <= 8) {
		out.push({
			type,
			...(stringValue(raw.custom_id) === undefined ? {} : { customId: stringValue(raw.custom_id) }),
			...(stringValue(raw.label) === undefined ? {} : { label: stringValue(raw.label) }),
			...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
		});
	}
	if (Array.isArray(raw.components)) collectButtons(raw.components, out);
}

export class WorldState {
	private readonly world: MockWorld;
	private readonly bansByGuild = new Map<string, Set<string>>();
	private readonly dmChannelByUser = new Map<string, string>();
	private readonly messageIdByToken = new Map<string, string>();
	private readonly channelIdByToken = new Map<string, string>();

	constructor(seed?: MockWorld) {
		this.world = seed ?? EMPTY_WORLD();
		this.world.roles ??= [];
		this.world.messages ??= [];
		for (const channel of this.world.channels) {
			if (channel.type === 1 && channel.id) this.dmChannelByUser.set(channel.id, channel.id);
		}
	}

	guild(guildId: string): GuildView | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		const channels = this.world.channels
			.filter(channel => channel.guild_id === guild.id)
			.map(channel => this.channelView(channel));
		const members = this.world.members
			.filter(entry => entry.guildId === guild.id)
			.map(entry => this.memberView(entry.member));
		const roles = this.world.roles.filter(entry => entry.guildId === guild.id).map(entry => entry.role);
		const bans = [...(this.bansByGuild.get(guild.id) ?? new Set<string>())];

		return {
			id: guild.id,
			name: guild.name,
			channels,
			channel: nameOrId =>
				this.world.channels
					.filter(channel => channel.guild_id === guild.id)
					.map(channel => this.channelView(channel))
					.find(channel => channel.id === nameOrId || channel.name === nameOrId),
			members,
			member: userId => {
				const entry = this.world.members.find(
					member => member.guildId === guild.id && member.member.user.id === userId,
				);
				return entry ? this.memberView(entry.member) : undefined;
			},
			role: nameOrId => {
				const role = roles.find(entry => entry.id === nameOrId || entry.name === nameOrId);
				return role ? { id: role.id, name: role.name, position: role.position } : undefined;
			},
			bans,
		};
	}

	dm(userId: string): ChannelView | undefined {
		const channelId = this.dmChannelByUser.get(userId);
		const channel = channelId ? this.world.channels.find(entry => entry.id === channelId) : undefined;
		return channel ? this.channelView(channel) : undefined;
	}

	channelMessages(channelId: string): Record<string, unknown>[] {
		return this.world.messages
			.filter(entry => entry.channelId === channelId)
			.map(entry => entry.message)
			.reverse()
			.map(message => ({ ...message }));
	}

	rawMessage(channelId: string, messageId: string): Record<string, unknown> | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? { ...entry.message } : undefined;
	}

	messageForToken(token: string): Record<string, unknown> | undefined {
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		return channelId && messageId ? this.rawMessage(channelId, messageId) : undefined;
	}

	channelForToken(token: string): string | undefined {
		return this.channelIdByToken.get(token);
	}

	registerInteractionToken(token: string, channelId: string): void {
		this.channelIdByToken.set(token, channelId);
	}

	/** @internal Mock internals normally call this when Discord creates a channel. */
	addChannel(guildId: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
		const channel = apiChannel({
			id: stringValue(raw.id),
			guildId: stringValue(raw.guild_id) ?? guildId ?? null,
			name: stringValue(raw.name),
			type: numberValue(raw.type),
			parentId: stringValue(raw.parent_id),
			permissionOverwrites: normalizeOverwrites(raw.permission_overwrites),
		});
		this.world.channels.push(channel);
		return { ...channel };
	}

	/** @internal Mock internals normally call this when Discord deletes a channel. */
	removeChannel(channelId: string): void {
		this.world.channels = this.world.channels.filter(channel => channel.id !== channelId);
		this.world.messages = this.world.messages.filter(message => message.channelId !== channelId);
		for (const [userId, dmChannelId] of this.dmChannelByUser) {
			if (dmChannelId === channelId) this.dmChannelByUser.delete(userId);
		}
	}

	/** @internal Mock internals normally call this when Discord opens a DM. */
	registerDm(userId: string, raw: Record<string, unknown>): Record<string, unknown> {
		const channel = this.addChannel(undefined, { ...raw, type: raw.type ?? 1 });
		this.dmChannelByUser.set(userId, String(channel.id));
		return channel;
	}

	/** @internal Mock internals normally call this when Discord creates a message. */
	addMessage(channelId: string, raw: Record<string, unknown>): MessageView {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const rawAuthor = asRecord(raw.author);
		const author: ApiUser =
			'id' in rawAuthor
				? ({
						...apiUser({ id: String(rawAuthor.id) }),
						...rawAuthor,
					} as ApiUser)
				: apiUser({ id: stringValue(raw.author_id) ?? TEST_BOT_ID, bot: true });
		const message = apiMessage({
			id: stringValue(raw.id),
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			author,
			content: stringValue(raw.content) ?? '',
			embeds: arrayValue(raw.embeds),
			components: arrayValue(raw.components),
			flags: numberValue(raw.flags),
		});
		this.world.messages.push({ channelId, message });
		return this.messageView(message);
	}

	/** @internal Mock internals normally call this when Discord edits a message. */
	editMessage(channelId: string, messageId: string, raw: Record<string, unknown>): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		if ('content' in raw) entry.message.content = stringValue(raw.content) ?? '';
		if ('embeds' in raw) entry.message.embeds = arrayValue(raw.embeds);
		if ('components' in raw) entry.message.components = arrayValue(raw.components);
		if ('flags' in raw) entry.message.flags = numberValue(raw.flags) ?? entry.message.flags;
	}

	/** @internal Mock internals normally call this when Discord deletes a message. */
	deleteMessage(channelId: string, messageId: string): void {
		this.world.messages = this.world.messages.filter(
			message => message.channelId !== channelId || message.message.id !== messageId,
		);
		for (const [token, id] of this.messageIdByToken) {
			if (id === messageId) this.messageIdByToken.delete(token);
		}
	}

	/** @internal Mock internals normally call this when Discord removes a member. */
	removeMember(guildId: string, userId: string, banned: boolean): void {
		this.world.members = this.world.members.filter(
			entry => entry.guildId !== guildId || entry.member.user.id !== userId,
		);
		if (banned) {
			const bans = this.bansByGuild.get(guildId) ?? new Set<string>();
			bans.add(userId);
			this.bansByGuild.set(guildId, bans);
		}
	}

	/** @internal Mock internals normally call this when Discord rewrites member roles. */
	setMemberRoles(guildId: string, userId: string, roles: string[]): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (entry) entry.member.roles = [...roles];
	}

	/** @internal Mock internals normally call this when Discord PATCHes a member. */
	patchMember(
		guildId: string,
		userId: string,
		patch: { nick?: string | null; roles?: string[]; communication_disabled_until?: string | null },
	): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (!entry) return;
		if ('nick' in patch) entry.member.nick = patch.nick ?? null;
		if (patch.roles) entry.member.roles = [...patch.roles];
		if ('communication_disabled_until' in patch) {
			entry.member.communication_disabled_until = patch.communication_disabled_until;
		}
	}

	/** @internal Mock internals normally call this when Discord creates a role. */
	addRole(guildId: string, raw: Record<string, unknown>): ApiRole {
		const role = apiRole({
			id: stringValue(raw.id),
			name: stringValue(raw.name),
			permissions: stringValue(raw.permissions),
			position: numberValue(raw.position),
		});
		this.world.roles.push({ guildId, role });
		return role;
	}

	/** @internal Mock internals normally call this for an interaction's first visible reply. */
	addOriginalResponse(
		token: string,
		channelId: string,
		raw: Record<string, unknown>,
		authorId: string,
	): Record<string, unknown> {
		this.registerInteractionToken(token, channelId);
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		this.messageIdByToken.set(token, view.id);
		return this.rawMessage(channelId, view.id) ?? {};
	}

	/** @internal Mock internals normally call this for webhook edits of @original. */
	upsertOriginalResponse(token: string, raw: Record<string, unknown>, authorId: string): Record<string, unknown> {
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const messageId = this.messageIdByToken.get(token);
		if (!messageId) return this.addOriginalResponse(token, channelId, raw, authorId);
		this.editMessage(channelId, messageId, raw);
		return this.rawMessage(channelId, messageId) ?? {};
	}

	/** @internal Mock internals normally call this for webhook followups. */
	addFollowup(token: string, raw: Record<string, unknown>, authorId: string): Record<string, unknown> {
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		return this.rawMessage(channelId, view.id) ?? {};
	}

	/** @internal Mock internals normally call this for webhook deletes of @original. */
	deleteOriginalResponse(token: string): void {
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		if (channelId && messageId) this.deleteMessage(channelId, messageId);
		this.messageIdByToken.delete(token);
	}

	private channelView(channel: ApiChannel): ChannelView {
		const messages = this.world.messages
			.filter(message => message.channelId === channel.id)
			.map(message => this.messageView(message.message));
		return {
			id: channel.id,
			name: channel.name,
			type: channel.type,
			parentId: channel.parent_id,
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
			messages,
			lastMessage: messages.at(-1),
		};
	}

	private memberView(member: {
		user: ApiUser;
		roles: string[];
		nick?: string | null;
		communication_disabled_until?: string | null;
	}): GuildMemberView {
		return {
			userId: member.user.id,
			roles: [...member.roles],
			nick: member.nick,
			communicationDisabledUntil: member.communication_disabled_until,
		};
	}

	private messageView(message: ApiMessage): MessageView {
		const buttons: ButtonView[] = [];
		collectButtons(message.components, buttons);
		return {
			id: message.id,
			channelId: message.channel_id,
			authorId: message.author.id,
			content: message.content,
			embeds: message.embeds.map(normalizeEmbed),
			components: [...message.components],
			buttons,
			button: labelOrCustomId =>
				buttons.find(button => button.label === labelOrCustomId || button.customId === labelOrCustomId),
		};
	}
}
