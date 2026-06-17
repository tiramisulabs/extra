import { mockId, mockTimestamp } from '../id';
import { TEST_BOT_ID } from './constants';
import { decodeEmoji, emojiPayload } from './emoji';
import { isEphemeral, MESSAGE_FLAG_COMPONENTS_V2 } from './message-flags';
import {
	type ApiAttachment,
	type ApiAuditLogEntry,
	type ApiAutoModRule,
	type ApiChannel,
	type ApiEmoji,
	type ApiGuildTemplate,
	type ApiInvite,
	type ApiMessage,
	type ApiPoll,
	type ApiRole,
	type ApiScheduledEvent,
	type ApiSoundboardSound,
	type ApiStageInstance,
	type ApiSticker,
	type ApiUser,
	type ApiVoiceState,
	type ApiWebhook,
	type AutoModAction,
	type AutoModTriggerMetadata,
	apiAttachment,
	apiAutoModRule,
	apiChannel,
	apiEmoji,
	apiGuildTemplate,
	apiInvite,
	apiMember,
	apiMessage,
	apiPoll,
	apiRole,
	apiScheduledEvent,
	apiStageInstance,
	apiSticker,
	apiUser,
	apiVoiceState,
	apiWebhook,
	type RawMessage,
	type ThreadMetadata,
} from './payloads';
import type { ChannelOverwriteLike } from './permissions';
import { apiError, ErrorCode } from './rest';
import type { MockWorld } from './world';

const MAX_MESSAGE_CONTENT = 2000;

const cp = (value: string): number => [...value].length;

/**
 * Reject an embed media/link URL whose scheme Discord forbids (real 50035 "Not a well formed URL"). `url` and
 * `author.url` accept only http/https; image/thumbnail/icon URLs additionally accept `attachment://`. Absent or
 * empty values are fine.
 */
function assertEmbedUrl(value: unknown, label: string, allowAttachment: boolean): void {
	if (typeof value !== 'string' || value.length === 0) return;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
	const ok = scheme === 'http' || scheme === 'https' || (allowAttachment && scheme === 'attachment');
	if (!ok) apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} is not a valid URL`);
}

/**
 * Validate a message's embeds against Discord's full documented limits (the F4 superset): at most 10 embeds;
 * per-embed title<=256, description<=4096, <=25 fields, each field name 1..256 and value 1..1024, footer
 * text<=2048, author name<=256, color a 0..0xFFFFFF integer, and well-formed media URLs; plus the combined
 * 6000-character cap across all embeds. Throws 50035 so an over-limit embed fails loud.
 */
function assertValidEmbeds(embeds: unknown[]): void {
	if (embeds.length > 10)
		apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a message can have at most 10 embeds');
	let total = 0;
	for (const entry of embeds) {
		const embed = asRecord(entry);
		const title = stringValue(embed.title);
		if (title !== undefined) {
			if (cp(title) > 256)
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: embed title must be 256 or fewer in length');
			total += cp(title);
		}
		const description = stringValue(embed.description);
		if (description !== undefined) {
			if (cp(description) > 4096) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed description must be 4096 or fewer in length',
				);
			}
			total += cp(description);
		}
		const fields = arrayValue(embed.fields);
		if (fields.length > 25)
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: an embed can have at most 25 fields');
		for (const rawField of fields) {
			const field = asRecord(rawField);
			const name = stringValue(field.name) ?? '';
			const value = stringValue(field.value) ?? '';
			if (cp(name) < 1 || cp(name) > 256) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed field name must be between 1 and 256 in length',
				);
			}
			if (cp(value) < 1 || cp(value) > 1024) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed field value must be between 1 and 1024 in length',
				);
			}
			total += cp(name) + cp(value);
		}
		const footer = asRecord(embed.footer);
		const footerText = stringValue(footer.text);
		if (footerText !== undefined) {
			if (cp(footerText) > 2048) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: embed footer text must be 2048 or fewer in length',
				);
			}
			total += cp(footerText);
		}
		const author = asRecord(embed.author);
		const authorName = stringValue(author.name);
		if (authorName !== undefined) {
			if (cp(authorName) > 256)
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: embed author name must be 256 or fewer in length');
			total += cp(authorName);
		}
		const color = numberValue(embed.color);
		if (color !== undefined && (!Number.isInteger(color) || color < 0 || color > 0xffffff)) {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: embed color must be an integer between 0 and 16777215',
			);
		}
		assertEmbedUrl(embed.url, 'embed url', false);
		assertEmbedUrl(author.url, 'embed author url', false);
		assertEmbedUrl(asRecord(embed.image).url, 'embed image url', true);
		assertEmbedUrl(asRecord(embed.thumbnail).url, 'embed thumbnail url', true);
		assertEmbedUrl(footer.icon_url, 'embed footer icon url', true);
		assertEmbedUrl(author.icon_url, 'embed author icon url', true);
	}
	if (total > 6000) {
		apiError(
			400,
			ErrorCode.InvalidFormBody,
			'Invalid Form Body: the combined length of all embeds must be 6000 or fewer in length',
		);
	}
}

/**
 * Validate an outgoing message's components against Discord's documented form limits (F5): every interactive
 * custom_id is <=100 chars and unique across the message, string selects carry 1..25 options, and select
 * min/max_values stay in 0..25 with min<=max. Throws a 50035 MockApiError, so an impossible component tree
 * fails loud instead of passing a happy-path test.
 */
function assertValidComponents(components: unknown): void {
	const customIds = new Set<string>();
	walkComponents(components, node => {
		const type = numberValue(node.type);
		const customId = stringValue(node.custom_id);
		if (customId !== undefined) {
			if ([...customId].length > 100) {
				apiError(
					400,
					ErrorCode.InvalidFormBody,
					'Invalid Form Body: component custom_id must be 100 or fewer in length',
				);
			}
			if (customIds.has(customId))
				apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: duplicate component custom_id "${customId}"`);
			customIds.add(customId);
		}
		if (type !== undefined && type >= 3 && type <= 8) {
			if (type === 3) {
				const options = arrayValue(node.options).length;
				if (options < 1 || options > 25) {
					apiError(
						400,
						ErrorCode.InvalidFormBody,
						'Invalid Form Body: a string select menu must have between 1 and 25 options',
					);
				}
			}
			const min = numberValue(node.min_values);
			const max = numberValue(node.max_values);
			if (min !== undefined && (min < 0 || min > 25)) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select min_values must be between 0 and 25');
			}
			if (max !== undefined && (max < 1 || max > 25)) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select max_values must be between 1 and 25');
			}
			if (min !== undefined && max !== undefined && min > max) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: select min_values cannot exceed max_values');
			}
		}
	});
}

/**
 * Validate an outgoing message body against Discord's documented limits, throwing a MockApiError (which the
 * REST layer surfaces like a real 400) so an over-limit send fails loud instead of passing a happy-path test.
 * `create` additionally rejects a fully empty body (real code 50006).
 */
function assertSendableMessage(raw: Record<string, unknown>, mode: 'create' | 'edit'): void {
	const content = typeof raw.content === 'string' ? raw.content : undefined;
	if (content !== undefined && [...content].length > MAX_MESSAGE_CONTENT) {
		apiError(
			400,
			ErrorCode.InvalidFormBody,
			`Invalid Form Body: content must be ${MAX_MESSAGE_CONTENT} or fewer in length`,
		);
	}
	const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
	assertValidEmbeds(embeds);
	// F19: a Components-v2 body forbids top-level content/embeds and requires a non-empty components tree.
	if (((numberValue(raw.flags) ?? 0) & MESSAGE_FLAG_COMPONENTS_V2) !== 0) {
		if (content !== undefined && content !== '') {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: content is not allowed with the IsComponentsV2 flag',
			);
		}
		if (embeds.length > 0)
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: embeds are not allowed with the IsComponentsV2 flag',
			);
		if (!Array.isArray(raw.components) || raw.components.length === 0) {
			apiError(
				400,
				ErrorCode.InvalidFormBody,
				'Invalid Form Body: the IsComponentsV2 flag requires a non-empty components array',
			);
		}
	}
	if (Array.isArray(raw.components)) assertValidComponents(raw.components);
	// F20: at most 3 stickers per message.
	if (Array.isArray(raw.sticker_ids) && raw.sticker_ids.length > 3) {
		apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a message can have at most 3 stickers');
	}
	// F21: poll create caps.
	if (raw.poll !== undefined) {
		const poll = asRecord(raw.poll);
		const question = stringValue(asRecord(poll.question).text);
		if (question !== undefined && [...question].length > 300) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll question must be 300 or fewer in length');
		}
		const answers = arrayValue(poll.answers);
		if (answers.length > 10)
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: a poll can have at most 10 answers');
		for (const entry of answers) {
			const text = stringValue(asRecord(asRecord(entry).poll_media).text);
			if (text !== undefined && [...text].length > 55) {
				apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll answer text must be 55 or fewer in length');
			}
		}
		const duration = numberValue(poll.duration);
		if (duration !== undefined && (duration < 1 || duration > 768)) {
			apiError(400, ErrorCode.InvalidFormBody, 'Invalid Form Body: poll duration must be between 1 and 768 hours');
		}
	}
	if (mode === 'create') {
		const empty =
			(content === undefined || content === '') &&
			embeds.length === 0 &&
			(!Array.isArray(raw.components) || raw.components.length === 0) &&
			raw.poll === undefined &&
			raw.message_reference === undefined &&
			(!Array.isArray(raw.sticker_ids) || raw.sticker_ids.length === 0) &&
			(!Array.isArray(raw.attachments) || raw.attachments.length === 0);
		if (empty) apiError(400, ErrorCode.CannotSendEmptyMessage, 'Cannot send an empty message');
	}
}

/**
 * F22: validate a name/topic field against Discord's documented bounds (and optional charset), throwing a
 * 50035 when out of range. No-ops for absent (undefined/null) values so partial patches stay valid.
 */
function assertNameBounds(value: unknown, min: number, max: number, label: string, charset?: RegExp): void {
	if (typeof value !== 'string') return;
	const length = [...value].length;
	if (length < min || length > max) {
		apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} must be between ${min} and ${max} in length`);
	}
	if (charset && value.length > 0 && !charset.test(value)) {
		apiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body: ${label} contains invalid characters`);
	}
}

const ATTACHMENT_SCHEME = 'attachment://';

function collectAttachmentRefs(value: unknown, out: Set<string>): void {
	if (typeof value === 'string') {
		if (value.startsWith(ATTACHMENT_SCHEME)) out.add(value.slice(ATTACHMENT_SCHEME.length));
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectAttachmentRefs(entry, out);
		return;
	}
	if (value && typeof value === 'object') {
		for (const entry of Object.values(value)) collectAttachmentRefs(entry, out);
	}
}

/**
 * F23: every `attachment://<filename>` reference in a message body (embed images, component-v2 media, etc.)
 * must be backed by a file uploaded in the SAME request — otherwise Discord drops the media silently. Reject
 * a reference with no matching uploaded filename so the missing-file mistake fails loud instead of passing green.
 */
export function assertAttachmentRefs(body: unknown, files: unknown): void {
	const refs = new Set<string>();
	collectAttachmentRefs(body, refs);
	if (refs.size === 0) return;
	const uploaded = new Set<string>();
	for (const file of arrayValue(files)) {
		const name = stringValue(asRecord(file).filename) ?? stringValue(asRecord(file).name);
		if (name !== undefined) uploaded.add(name);
	}
	for (const ref of refs) {
		if (!uploaded.has(ref)) {
			apiError(
				400,
				50035,
				`Invalid Form Body: references attachment://${ref} but no file named "${ref}" was uploaded in this request`,
			);
		}
	}
}

export interface MessageQuery {
	limit?: number;
	before?: string;
	after?: string;
	around?: string;
}

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

export interface ReactionView {
	emoji: string;
	count: number;
	me: boolean;
	users: string[];
}

export interface AttachmentView {
	id: string;
	filename: string;
	contentType?: string;
	size?: number;
	url?: string;
}

export interface MessageReferenceView {
	messageId?: string;
	channelId?: string;
	type?: number;
}

export interface MessageView {
	id: string;
	channelId: string;
	authorId?: string;
	content?: string;
	embeds: EmbedView[];
	components: unknown[];
	attachments: AttachmentView[];
	isComponentsV2: boolean;
	componentTypes: number[];
	textDisplays: string[];
	buttons: ButtonView[];
	button(labelOrCustomId: string): ButtonView | undefined;
	reactions: ReactionView[];
	reaction(emoji: string): ReactionView | undefined;
	reference?: MessageReferenceView;
	referencedMessage?: { id: string; channelId: string; authorId?: string; content?: string };
	snapshots: { content?: string; embeds: EmbedView[] }[];
	poll?: { question?: string; answers: { answerId: number; text?: string }[]; isFinalized: boolean };
}

export interface ChannelView {
	id: string;
	name?: string;
	type: number;
	parentId?: string;
	topic?: string | null;
	nsfw: boolean;
	rateLimitPerUser?: number;
	position: number;
	archived?: boolean;
	locked?: boolean;
	threadMetadata?: ThreadMetadata;
	overwrites: { id: string; type: number; allow: string; deny: string }[];
	messages: MessageView[];
	lastMessage?: MessageView;
	pins: MessageView[];
}

export interface GuildMemberView {
	userId: string;
	roles: string[];
	nick?: string | null;
	communicationDisabledUntil?: string | null;
}

/** Role projection returned by guild/role readers; carries the stored permissions and color, not just identity. */
export interface RoleView {
	id: string;
	name: string;
	position: number;
	permissions: string;
	color: number;
}

export interface GuildView {
	id: string;
	name?: string;
	channels: ChannelView[];
	channel(nameOrId: string): ChannelView | undefined;
	threads: ChannelView[];
	thread(nameOrId: string): ChannelView | undefined;
	members: GuildMemberView[];
	member(userId: string): GuildMemberView | undefined;
	role(nameOrId: string): RoleView | undefined;
	bans: string[];
	emojis: { id: string; name: string }[];
	emoji(nameOrId: string): { id: string; name: string } | undefined;
	invites: { code: string; channelId: string; uses: number }[];
	autoModRules: ApiAutoModRule[];
	autoModRule(id: string): ApiAutoModRule | undefined;
	stickers: { id: string; name: string }[];
	sticker(nameOrId: string): { id: string; name: string } | undefined;
	scheduledEvents: ApiScheduledEvent[];
}

/** One member captured in a {@link WorldSnapshot}, identified by `guildId` + `userId`. */
export interface MemberSnapshot {
	guildId: string;
	userId: string;
	roles: string[];
	nick: string | null;
	communicationDisabledUntil: string | null;
}

/** One channel captured in a {@link WorldSnapshot}, identified by `id`. */
export interface ChannelSnapshot {
	id: string;
	guildId?: string;
	name: string;
	type: number;
	parentId?: string;
	overwrites: { id: string; type: number; allow: string; deny: string }[];
}

/** One message captured in a {@link WorldSnapshot}, identified by `id`. */
export interface MessageSnapshot {
	id: string;
	channelId: string;
	authorId: string;
	content: string;
}

/** One role captured in a {@link WorldSnapshot}, identified by `id`. */
export interface RoleSnapshot {
	guildId: string;
	id: string;
	name: string;
	permissions: string;
	position: number;
}

/** One ban captured in a {@link WorldSnapshot}, identified by `guildId` + `userId`. */
export interface BanSnapshot {
	guildId: string;
	userId: string;
}

/** One emoji captured in a {@link WorldSnapshot}, identified by `guildId` + `id`. */
export interface EmojiSnapshot {
	guildId: string;
	id: string;
	name: string | null;
}

/** One invite captured in a {@link WorldSnapshot}, identified by `code`. */
export interface InviteSnapshot {
	code: string;
	channelId: string;
	uses: number;
}

/** One automod rule captured in a {@link WorldSnapshot}, identified by `guildId` + `id`. */
export interface AutoModRuleSnapshot {
	guildId: string;
	id: string;
	name: string;
	enabled: boolean;
}

/** One sticker captured in a {@link WorldSnapshot}, identified by `guildId` + `id`. */
export interface StickerSnapshot {
	guildId: string;
	id: string;
	name: string;
}

/** One scheduled event captured in a {@link WorldSnapshot}, identified by `guildId` + `id`. */
export interface ScheduledEventSnapshot {
	guildId: string;
	id: string;
	name: string;
	status: number;
	startTime: string;
	channelId: string | null;
}

/** One webhook captured in a {@link WorldSnapshot}, identified by `id`. */
export interface WebhookSnapshot {
	id: string;
	channelId: string;
	name: string | null;
}

/** One pinned message captured in a {@link WorldSnapshot}, identified by `channelId` + `messageId`. */
export interface PinSnapshot {
	channelId: string;
	messageId: string;
}

/**
 * Immutable, plain-data capture of the world at a point in time. Produced by {@link WorldState.snapshot}
 * and consumed by {@link WorldState.diff}. Deeply frozen so later world mutations never alter it.
 */
export interface WorldSnapshot {
	members: MemberSnapshot[];
	channels: ChannelSnapshot[];
	messages: MessageSnapshot[];
	roles: RoleSnapshot[];
	bans: BanSnapshot[];
	emojis: EmojiSnapshot[];
	invites: InviteSnapshot[];
	autoModRules: AutoModRuleSnapshot[];
	stickers: StickerSnapshot[];
	scheduledEvents: ScheduledEventSnapshot[];
	webhooks: WebhookSnapshot[];
	pins: PinSnapshot[];
}

/** A single entity that changed between two snapshots, with the names of the differing fields. */
export interface ChangedEntity<T> {
	before: T;
	after: T;
	fields: string[];
}

/** Added/removed/changed buckets for one entity type in a {@link WorldDiff}. */
export interface EntityDiff<T> {
	added: T[];
	removed: T[];
	changed: ChangedEntity<T>[];
}

/**
 * Structured changeset between a prior {@link WorldSnapshot} and the current world, keyed by entity type.
 * Entities are matched by their stable id (member/ban = guildId+userId, channel/message/role = id);
 * `changed` lists the entities present in both with differing fields.
 */
export interface WorldDiff {
	members: EntityDiff<MemberSnapshot>;
	channels: EntityDiff<ChannelSnapshot>;
	messages: EntityDiff<MessageSnapshot>;
	roles: EntityDiff<RoleSnapshot>;
	bans: EntityDiff<BanSnapshot>;
	emojis: EntityDiff<EmojiSnapshot>;
	invites: EntityDiff<InviteSnapshot>;
	autoModRules: EntityDiff<AutoModRuleSnapshot>;
	stickers: EntityDiff<StickerSnapshot>;
	scheduledEvents: EntityDiff<ScheduledEventSnapshot>;
	webhooks: EntityDiff<WebhookSnapshot>;
	pins: EntityDiff<PinSnapshot>;
}

/**
 * The read-only view of {@link WorldState} exposed publicly as `bot.state`. Exposes only the query
 * methods test authors call to assert on world state; the `@internal` mutators that the mock drives
 * in response to Discord traffic are intentionally absent so an internal refactor of them is not a
 * breaking change. The concrete {@link WorldState} class implements this and is used internally.
 */
export interface WorldStateReader {
	snapshot(): WorldSnapshot;
	diff(before: WorldSnapshot): WorldDiff;
	guild(guildId: string): GuildView | undefined;
	/** A channel view by id alone (Discord keys channels globally) — the symmetric partner of cachedGuild(g).channel(id). */
	channelById(channelId: string): ChannelView | undefined;
	/** A role view by id alone, carrying permissions/color — the symmetric partner of cachedGuild(g).role(id). */
	roleById(roleId: string): RoleView | undefined;
	/** The stored voice state for a member, or undefined. */
	voiceState(guildId: string, userId: string): ApiVoiceState | undefined;
	dm(userId: string): ChannelView | undefined;
	channelMessages(channelId: string, options?: MessageQuery): RawMessage[];
	messageView(channelId: string, messageId: string): MessageView | undefined;
	rawMessage(channelId: string, messageId: string): RawMessage | undefined;
	rawMessageById(messageId: string): RawMessage | undefined;
	messageForToken(token: string): RawMessage | undefined;
	webhookMessage(token: string, messageId: string): RawMessage | undefined;
	channelForToken(token: string): string | undefined;
	reactionUsers(channelId: string, messageId: string, emoji: string): string[];
	bans(guildId: string): string[];
	isBanned(guildId: string, userId: string): boolean;
	pins(channelId: string): RawMessage[];
	archivedThreads(channelId: string, type: 'public' | 'private'): ApiChannel[];
	pollVoters(channelId: string, messageId: string, answerId: number): string[];
	emojis(guildId: string): ApiEmoji[];
	emoji(guildId: string, emojiId: string): ApiEmoji | undefined;
	invites(): ApiInvite[];
	invite(code: string): ApiInvite | undefined;
	channelInvites(channelId: string): ApiInvite[];
	guildInvites(guildId: string): ApiInvite[];
	autoModRules(guildId: string): ApiAutoModRule[];
	autoModRule(guildId: string, ruleId: string): ApiAutoModRule | undefined;
	threadMembers(channelId: string): string[];
	activeThreads(guildId: string): ApiChannel[];
	webhookById(id: string): ApiWebhook | undefined;
	webhooksForGuild(guildId: string): ApiWebhook[];
	webhooksForChannel(channelId: string): ApiWebhook[];
	stickers(guildId: string): ApiSticker[];
	sticker(guildId: string, stickerId: string): ApiSticker | undefined;
	scheduledEvents(guildId: string): ApiScheduledEvent[];
	scheduledEvent(guildId: string, eventId: string): ApiScheduledEvent | undefined;
	guildTemplates(guildId: string): ApiGuildTemplate[];
	soundboardSounds(guildId: string): ApiSoundboardSound[];
	stageInstance(channelId: string): ApiStageInstance | undefined;
	auditLogEntries(guildId: string): ApiAuditLogEntry[];
}

const EMPTY_WORLD = (): MockWorld => ({ guilds: [], channels: [], users: [], members: [], roles: [], messages: [] });

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}

/** Field-by-field comparison for the snapshot scalar/array fields; lists the names that differ. */
function changedFields<T extends object>(before: T, after: T): string[] {
	const fields: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const a = (before as Record<string, unknown>)[key];
		const b = (after as Record<string, unknown>)[key];
		if (JSON.stringify(a) !== JSON.stringify(b)) fields.push(key);
	}
	return fields;
}

function diffEntities<T extends object>(before: T[], after: T[], identity: (entity: T) => string): EntityDiff<T> {
	const beforeById = new Map(before.map(entity => [identity(entity), entity]));
	const afterById = new Map(after.map(entity => [identity(entity), entity]));
	const result: EntityDiff<T> = { added: [], removed: [], changed: [] };
	for (const [id, entity] of afterById) {
		const prior = beforeById.get(id);
		if (!prior) {
			result.added.push(entity);
			continue;
		}
		const fields = changedFields(prior, entity);
		if (fields.length) result.changed.push({ before: prior, after: entity, fields });
	}
	for (const [id, entity] of beforeById) {
		if (!afterById.has(id)) result.removed.push(entity);
	}
	return result;
}

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

function normalizeThreadMetadata(value: unknown): ThreadMetadata {
	const raw = asRecord(value);
	return {
		archived: typeof raw.archived === 'boolean' ? raw.archived : false,
		auto_archive_duration: numberValue(raw.auto_archive_duration) ?? 1440,
		locked: typeof raw.locked === 'boolean' ? raw.locked : false,
		archive_timestamp: stringValue(raw.archive_timestamp) ?? mockTimestamp(),
	};
}

function normalizePoll(raw: Record<string, unknown>): ApiPoll {
	const question = asRecord(raw.question);
	return apiPoll({
		question: stringValue(question.text) === undefined ? {} : { text: stringValue(question.text) },
		answers: arrayValue(raw.answers).map(entry => {
			const media = asRecord(asRecord(entry).poll_media);
			return stringValue(media.text) === undefined ? {} : { text: stringValue(media.text) };
		}),
		...(typeof raw.allow_multiselect === 'boolean' ? { allowMultiselect: raw.allow_multiselect } : {}),
		...(numberValue(raw.layout_type) === undefined ? {} : { layoutType: numberValue(raw.layout_type) }),
	});
}

function normalizeAttachments(value: unknown): ApiAttachment[] {
	return arrayValue(value).map(entry => {
		const raw = asRecord(entry);
		return apiAttachment({
			...(stringValue(raw.id) === undefined ? {} : { id: stringValue(raw.id) }),
			...(stringValue(raw.filename) === undefined ? {} : { filename: stringValue(raw.filename) }),
			...(stringValue(raw.content_type) === undefined ? {} : { contentType: stringValue(raw.content_type) }),
			...(numberValue(raw.size) === undefined ? {} : { size: numberValue(raw.size) }),
			...(stringValue(raw.url) === undefined ? {} : { url: stringValue(raw.url) }),
		});
	});
}

function roleView(role: { id: string; name: string; position: number; permissions: string; color: number }): RoleView {
	return { id: role.id, name: role.name, position: role.position, permissions: role.permissions, color: role.color };
}

export function normalizeEmbed(value: unknown): EmbedView {
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

interface DerivedMentions {
	mention_everyone: boolean;
	mentions: ApiUser[];
	mention_roles: string[];
}

export function collectButtons(value: unknown, out: ButtonView[]): void {
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

/**
 * Walk a (possibly nested) Components v2 tree — containers (17), sections (9, plus their `accessory`),
 * action rows (1), etc. — visiting every node so v2 layouts can be surfaced flat for assertions.
 */
export function walkComponents(value: unknown, visit: (node: Record<string, unknown>) => void): void {
	for (const entry of arrayValue(value)) {
		const node = asRecord(entry);
		visit(node);
		if (node.accessory !== undefined) visit(asRecord(node.accessory));
		if (Array.isArray(node.components)) walkComponents(node.components, visit);
	}
}

/**
 * Flatten a (possibly v2-nested) components tree into its interactive buttons, every node `type` in tree order,
 * and the TextDisplay (type 10) contents — the shared projection used by both the dispatch result and MessageView.
 */
export function harvestComponents(components: unknown): {
	buttons: ButtonView[];
	componentTypes: number[];
	textDisplays: string[];
} {
	const buttons: ButtonView[] = [];
	const componentTypes: number[] = [];
	const textDisplays: string[] = [];
	collectButtons(components, buttons);
	walkComponents(components, node => {
		const type = numberValue(node.type);
		if (type !== undefined) componentTypes.push(type);
		if (type === 10 && typeof node.content === 'string') textDisplays.push(node.content);
	});
	return { buttons, componentTypes, textDisplays };
}

export class WorldState implements WorldStateReader {
	private readonly world: MockWorld;
	private readonly bansByGuild = new Map<string, Set<string>>();
	private readonly dmChannelByUser = new Map<string, string>();
	private readonly messageIdByToken = new Map<string, string>();
	private readonly channelIdByToken = new Map<string, string>();
	private readonly originTypeByToken = new Map<string, number>();
	private readonly acknowledgedTokens = new Set<string>();
	private readonly componentSourceByToken = new Map<string, { channelId: string; messageId: string }>();
	private readonly invitesByCode = new Map<string, ApiInvite>();
	private readonly webhooksById = new Map<string, ApiWebhook>();
	private readonly reactionsByMessage = new Map<string, Map<string, Set<string>>>();
	private readonly pinnedByChannel = new Map<string, string[]>();
	private readonly pollVotersByMessage = new Map<string, Map<number, Set<string>>>();
	private readonly threadMembersByChannel = new Map<string, Set<string>>();

	constructor(seed?: MockWorld) {
		this.world = seed ?? EMPTY_WORLD();
		this.world.roles ??= [];
		this.world.messages ??= [];
		this.world.guildEmojis ??= [];
		this.world.autoModRules ??= [];
		for (const invite of this.world.invites ?? []) this.invitesByCode.set(invite.code, invite);
		for (const webhook of this.world.webhooks ?? []) this.webhooksById.set(webhook.id, webhook);
		for (const channel of this.world.channels) {
			if (channel.type === 1 && channel.id) this.dmChannelByUser.set(channel.id, channel.id);
		}
	}

	/**
	 * Capture the current world entities (members, channels, messages, roles, bans) as an immutable,
	 * plain-data snapshot. Deeply frozen, so later world mutations never alter a captured snapshot. Pair
	 * with {@link diff} to read state mutations declaratively instead of with field-by-field point queries.
	 */
	snapshot(): WorldSnapshot {
		const members: MemberSnapshot[] = this.world.members.map(entry => ({
			guildId: entry.guildId,
			userId: entry.member.user.id,
			roles: [...entry.member.roles],
			nick: entry.member.nick ?? null,
			communicationDisabledUntil: entry.member.communication_disabled_until ?? null,
		}));
		const channels: ChannelSnapshot[] = this.world.channels.map(channel => ({
			id: channel.id,
			...(channel.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			name: channel.name,
			type: channel.type,
			...(channel.parent_id === undefined ? {} : { parentId: channel.parent_id }),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
		}));
		const messages: MessageSnapshot[] = this.world.messages.map(entry => ({
			id: entry.message.id,
			channelId: entry.channelId,
			authorId: entry.message.author.id,
			content: entry.message.content,
		}));
		const roles: RoleSnapshot[] = this.world.roles.map(entry => ({
			guildId: entry.guildId,
			id: entry.role.id,
			name: entry.role.name,
			permissions: entry.role.permissions,
			position: entry.role.position,
		}));
		const bans: BanSnapshot[] = [...this.bansByGuild].flatMap(([guildId, userIds]) =>
			[...userIds].map(userId => ({ guildId, userId })),
		);
		const emojis: EmojiSnapshot[] = (this.world.guildEmojis ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.emoji.id,
			name: entry.emoji.name,
		}));
		const invites: InviteSnapshot[] = [...this.invitesByCode.values()].map(invite => ({
			code: invite.code,
			channelId: invite.channel_id,
			uses: invite.uses,
		}));
		const autoModRules: AutoModRuleSnapshot[] = (this.world.autoModRules ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.rule.id,
			name: entry.rule.name,
			enabled: entry.rule.enabled,
		}));
		const stickers: StickerSnapshot[] = (this.world.guildStickers ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.sticker.id,
			name: entry.sticker.name,
		}));
		const scheduledEvents: ScheduledEventSnapshot[] = (this.world.scheduledEvents ?? []).map(entry => ({
			guildId: entry.guildId,
			id: entry.event.id,
			name: entry.event.name,
			status: entry.event.status,
			startTime: entry.event.scheduled_start_time,
			channelId: entry.event.channel_id,
		}));
		const webhooks: WebhookSnapshot[] = [...this.webhooksById.values()].map(webhook => ({
			id: webhook.id,
			channelId: webhook.channel_id,
			name: webhook.name,
		}));
		const pins: PinSnapshot[] = [...this.pinnedByChannel].flatMap(([channelId, messageIds]) =>
			messageIds.map(messageId => ({ channelId, messageId })),
		);
		return deepFreeze({
			members,
			channels,
			messages,
			roles,
			bans,
			emojis,
			invites,
			autoModRules,
			stickers,
			scheduledEvents,
			webhooks,
			pins,
		});
	}

	/**
	 * Compare a prior {@link WorldSnapshot} against the CURRENT world and return a structured changeset.
	 * Entities are matched by stable id (member/ban = guildId+userId, channel/message/role = id); `changed`
	 * lists entities present in both whose fields differ, naming those fields.
	 */
	diff(before: WorldSnapshot): WorldDiff {
		const after = this.snapshot();
		return {
			members: diffEntities(before.members, after.members, entity => `${entity.guildId}:${entity.userId}`),
			channels: diffEntities(before.channels, after.channels, entity => entity.id),
			messages: diffEntities(before.messages, after.messages, entity => entity.id),
			roles: diffEntities(before.roles, after.roles, entity => entity.id),
			bans: diffEntities(before.bans, after.bans, entity => `${entity.guildId}:${entity.userId}`),
			emojis: diffEntities(before.emojis, after.emojis, entity => `${entity.guildId}:${entity.id}`),
			invites: diffEntities(before.invites, after.invites, entity => entity.code),
			autoModRules: diffEntities(before.autoModRules, after.autoModRules, entity => `${entity.guildId}:${entity.id}`),
			stickers: diffEntities(before.stickers, after.stickers, entity => `${entity.guildId}:${entity.id}`),
			scheduledEvents: diffEntities(
				before.scheduledEvents,
				after.scheduledEvents,
				entity => `${entity.guildId}:${entity.id}`,
			),
			webhooks: diffEntities(before.webhooks, after.webhooks, entity => entity.id),
			pins: diffEntities(before.pins, after.pins, entity => `${entity.channelId}:${entity.messageId}`),
		};
	}

	guild(guildId: string): GuildView | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		const guildChannels = this.world.channels.filter(channel => channel.guild_id === guild.id);
		const channels = guildChannels
			.filter(channel => !channel.thread_metadata)
			.map(channel => this.channelView(channel));
		const threads = guildChannels.filter(channel => channel.thread_metadata).map(channel => this.channelView(channel));
		const members = this.world.members
			.filter(entry => entry.guildId === guild.id)
			.map(entry => this.memberView(entry.member));
		const roles = this.world.roles.filter(entry => entry.guildId === guild.id).map(entry => entry.role);
		const bans = [...(this.bansByGuild.get(guild.id) ?? new Set<string>())];
		const guildEmojis = (this.world.guildEmojis ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.emoji);
		const guildInvites = [...this.invitesByCode.values()].filter(invite => invite.guild_id === guild.id);
		const guildAutoModRules = (this.world.autoModRules ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.rule);
		const guildStickers = (this.world.guildStickers ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.sticker);
		const guildScheduledEvents = (this.world.scheduledEvents ?? [])
			.filter(entry => entry.guildId === guild.id)
			.map(entry => entry.event);

		return {
			id: guild.id,
			name: guild.name,
			channels,
			channel: nameOrId => channels.find(channel => channel.id === nameOrId || channel.name === nameOrId),
			threads,
			thread: nameOrId => threads.find(channel => channel.id === nameOrId || channel.name === nameOrId),
			members,
			member: userId => members.find(entry => entry.userId === userId),
			role: nameOrId => {
				const role = roles.find(entry => entry.id === nameOrId || entry.name === nameOrId);
				return role ? roleView(role) : undefined;
			},
			bans,
			emojis: guildEmojis.map(emoji => ({ id: emoji.id, name: emoji.name })),
			emoji: nameOrId => {
				const emoji = guildEmojis.find(entry => entry.id === nameOrId || entry.name === nameOrId);
				return emoji ? { id: emoji.id, name: emoji.name } : undefined;
			},
			invites: guildInvites.map(invite => ({ code: invite.code, channelId: invite.channel_id, uses: invite.uses })),
			autoModRules: guildAutoModRules,
			autoModRule: id => guildAutoModRules.find(rule => rule.id === id),
			stickers: guildStickers.map(sticker => ({ id: sticker.id, name: sticker.name })),
			sticker: nameOrId => {
				const sticker = guildStickers.find(entry => entry.id === nameOrId || entry.name === nameOrId);
				return sticker ? { id: sticker.id, name: sticker.name } : undefined;
			},
			scheduledEvents: guildScheduledEvents,
		};
	}

	channelById(channelId: string): ChannelView | undefined {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		return channel ? this.channelView(channel) : undefined;
	}

	roleById(roleId: string): RoleView | undefined {
		const role = this.world.roles.find(entry => entry.role.id === roleId)?.role;
		return role ? roleView(role) : undefined;
	}

	voiceState(guildId: string, userId: string): ApiVoiceState | undefined {
		return this.world.voiceStates?.find(entry => entry.guildId === guildId && entry.voiceState.user_id === userId)
			?.voiceState;
	}

	dm(userId: string): ChannelView | undefined {
		const channelId = this.dmChannelByUser.get(userId);
		const channel = channelId ? this.world.channels.find(entry => entry.id === channelId) : undefined;
		return channel ? this.channelView(channel) : undefined;
	}

	channelMessages(channelId: string, options?: MessageQuery): RawMessage[] {
		const chronological = this.world.messages
			.filter(entry => entry.channelId === channelId && !isEphemeral(entry.message))
			.map(entry => entry.message);
		const newestFirst = [...chronological].reverse();
		const limit = Math.min(Math.max(options?.limit ?? 50, 0), 100);

		if (options?.after !== undefined) {
			const index = chronological.findIndex(message => message.id === options.after);
			const newer = index === -1 ? newestFirst : newestFirst.filter((_, i) => i < newestFirst.length - index - 1);
			return newer.slice(-limit).map(message => ({ ...message }));
		}

		let slice = newestFirst;
		if (options?.before !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.before);
			slice = index === -1 ? newestFirst : newestFirst.slice(index + 1);
		} else if (options?.around !== undefined) {
			const index = newestFirst.findIndex(message => message.id === options.around);
			if (index !== -1) {
				const half = Math.floor(limit / 2);
				slice = newestFirst.slice(Math.max(0, index - half), index - half + limit);
			}
		}
		return slice.slice(0, limit).map(message => ({ ...message }));
	}

	rawMessage(channelId: string, messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	rawMessageById(messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(message => message.message.id === messageId);
		return entry ? this.withReactions(entry.channelId, entry.message) : undefined;
	}

	/** The {@link MessageView} for a stored message, or undefined when it is not in the channel. */
	messageView(channelId: string, messageId: string): MessageView | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		return entry ? this.buildMessageView(entry.message) : undefined;
	}

	/** Discord reflects reactions on the message object as `{ emoji, count, me }`. */
	private withReactions(channelId: string, message: ApiMessage): RawMessage {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, message.id));
		if (!byEmoji || byEmoji.size === 0) return { ...message };
		const reactions = [...byEmoji].map(([emoji, users]) => ({
			emoji: emojiPayload(emoji),
			count: users.size,
			me: users.has(TEST_BOT_ID),
		}));
		return { ...message, reactions };
	}

	private rawMessageOr(channelId: string, messageId: string): RawMessage {
		return this.rawMessage(channelId, messageId) ?? apiMessage();
	}

	messageForToken(token: string): RawMessage | undefined {
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		return channelId && messageId ? this.rawMessage(channelId, messageId) : undefined;
	}

	webhookMessage(token: string, messageId: string): RawMessage | undefined {
		if (messageId === '@original') return this.messageForToken(token);
		const channelId = this.channelIdByToken.get(token);
		return channelId ? this.rawMessage(channelId, messageId) : undefined;
	}

	channelForToken(token: string): string | undefined {
		return this.channelIdByToken.get(token);
	}

	registerInteractionToken(token: string, channelId: string, originType?: number): void {
		this.channelIdByToken.set(token, channelId);
		if (originType !== undefined) this.originTypeByToken.set(token, originType);
	}

	/** The originating interaction type (2 command, 3 component, 5 modal submit) for a token, if known. */
	interactionOrigin(token: string): number | undefined {
		return this.originTypeByToken.get(token);
	}

	/** @internal Mark an interaction acknowledged (any callback: reply/defer/update/modal). */
	acknowledgeToken(token: string): void {
		this.acknowledgedTokens.add(token);
	}

	/** Whether the interaction was acknowledged — followups/@original ops 404 until it is. */
	isAcknowledged(token: string): boolean {
		return this.acknowledgedTokens.has(token);
	}

	/** @internal Point a token at an EXISTING message as its @original (deferUpdate on a component). */
	registerOriginalResponse(token: string, channelId: string, messageId: string): void {
		this.channelIdByToken.set(token, channelId);
		this.messageIdByToken.set(token, messageId);
	}

	/** @internal Record a component interaction's source message so a deferUpdate can point @original at it. */
	registerComponentSource(token: string, channelId: string, messageId: string): void {
		this.componentSourceByToken.set(token, { channelId, messageId });
	}

	/** The message a component interaction was raised on, if known. */
	componentSource(token: string): { channelId: string; messageId: string } | undefined {
		return this.componentSourceByToken.get(token);
	}

	/** @internal When Discord creates a channel. */
	addChannel(guildId: string | undefined, raw: Record<string, unknown>): Record<string, unknown> {
		const type = numberValue(raw.type);
		const parentId = stringValue(raw.parent_id);
		const isThread = type === 11 || type === 12 || raw.thread_metadata !== undefined;
		const channel = apiChannel({
			id: stringValue(raw.id),
			guildId: stringValue(raw.guild_id) ?? guildId ?? null,
			name: stringValue(raw.name),
			type,
			...(parentId === undefined ? {} : { parentId }),
			permissionOverwrites: normalizeOverwrites(raw.permission_overwrites),
			...(isThread ? { threadMetadata: normalizeThreadMetadata(raw.thread_metadata) } : {}),
		});
		this.world.channels.push(channel);
		return { ...channel };
	}

	/** @internal When Discord deletes a channel. */
	removeChannel(channelId: string): void {
		this.world.channels = this.world.channels.filter(channel => channel.id !== channelId);
		for (const message of this.world.messages) {
			if (message.channelId === channelId)
				this.reactionsByMessage.delete(this.reactionKey(channelId, message.message.id));
		}
		this.world.messages = this.world.messages.filter(message => message.channelId !== channelId);
		this.pinnedByChannel.delete(channelId);
		this.threadMembersByChannel.delete(channelId);
		for (const [userId, dmChannelId] of this.dmChannelByUser) {
			if (dmChannelId === channelId) this.dmChannelByUser.delete(userId);
		}
	}

	/**
	 * @internal On VOICE_STATE_UPDATE. Upserts the voice state for
	 * `{guild_id, user_id}`; a null `channel_id` is a disconnect and removes the entry.
	 */
	setVoiceState(raw: Record<string, unknown>): void {
		const guildId = stringValue(raw.guild_id);
		const userId = stringValue(raw.user_id);
		if (!guildId || !userId) return;
		const states = (this.world.voiceStates ??= []);
		const channelId = 'channel_id' in raw ? (stringValue(raw.channel_id) ?? null) : null;
		if (channelId === null) {
			this.world.voiceStates = states.filter(
				entry => !(entry.guildId === guildId && entry.voiceState.user_id === userId),
			);
			return;
		}
		const voiceState: ApiVoiceState = {
			...apiVoiceState({
				userId,
				channelId,
				...(stringValue(raw.session_id) === undefined ? {} : { sessionId: stringValue(raw.session_id) }),
				...(typeof raw.deaf === 'boolean' ? { deaf: raw.deaf } : {}),
				...(typeof raw.mute === 'boolean' ? { mute: raw.mute } : {}),
				...(typeof raw.self_deaf === 'boolean' ? { selfDeaf: raw.self_deaf } : {}),
				...(typeof raw.self_mute === 'boolean' ? { selfMute: raw.self_mute } : {}),
				...(typeof raw.self_video === 'boolean' ? { selfVideo: raw.self_video } : {}),
				...(typeof raw.suppress === 'boolean' ? { suppress: raw.suppress } : {}),
			}),
			guild_id: guildId,
		};
		const existing = states.find(entry => entry.guildId === guildId && entry.voiceState.user_id === userId);
		if (existing) existing.voiceState = voiceState;
		else states.push({ guildId, voiceState });
	}

	/** @internal When Discord opens a DM. */
	registerDm(userId: string, raw: Record<string, unknown>): Record<string, unknown> {
		const channel = this.addChannel(undefined, { ...raw, type: raw.type ?? 1 });
		this.dmChannelByUser.set(userId, String(channel.id));
		return channel;
	}

	private resolveUser(id: string): ApiUser {
		const user = this.world.users.find(entry => entry.id === id);
		if (user) return user;
		const member = this.world.members.find(entry => entry.member.user.id === id);
		return member ? member.member.user : apiUser({ id });
	}

	private deriveMentions(content: string, allowedMentions: unknown): DerivedMentions {
		const allowed = asRecord(allowedMentions);
		const hasAllowed = allowedMentions !== undefined && allowedMentions !== null;
		const parse = Array.isArray(allowed.parse) ? (allowed.parse as unknown[]).map(String) : undefined;
		const userAllowlist = Array.isArray(allowed.users) ? (allowed.users as unknown[]).map(String) : undefined;
		const roleAllowlist = Array.isArray(allowed.roles) ? (allowed.roles as unknown[]).map(String) : undefined;

		const allowCategory = (category: string, allowlist: string[] | undefined): boolean => {
			if (allowlist) return true;
			if (parse) return parse.includes(category);
			return true;
		};

		const result: DerivedMentions = { mention_everyone: false, mentions: [], mention_roles: [] };
		if (!hasAllowed && content === '') return result;

		if (allowCategory('users', userAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@!?(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (userAllowlist && !userAllowlist.includes(id)) continue;
				result.mentions.push(this.resolveUser(id));
			}
		}

		if (allowCategory('roles', roleAllowlist)) {
			const ids = new Set<string>();
			for (const match of content.matchAll(/<@&(\d+)>/g)) ids.add(match[1]);
			for (const id of ids) {
				if (roleAllowlist && !roleAllowlist.includes(id)) continue;
				result.mention_roles.push(id);
			}
		}

		if (allowCategory('everyone', undefined) && /@everyone|@here/.test(content)) {
			result.mention_everyone = true;
		}

		return result;
	}

	/** @internal When Discord creates a message. */
	addMessage(channelId: string, raw: Record<string, unknown>): MessageView {
		assertSendableMessage(raw, 'create');
		const channel = this.world.channels.find(entry => entry.id === channelId);
		const rawAuthor = asRecord(raw.author);
		const author: ApiUser =
			'id' in rawAuthor
				? ({
						...apiUser({ id: String(rawAuthor.id) }),
						...rawAuthor,
					} as ApiUser)
				: apiUser({ id: stringValue(raw.author_id) ?? TEST_BOT_ID, bot: true });
		const content = stringValue(raw.content) ?? '';
		const message = apiMessage({
			id: stringValue(raw.id),
			channelId,
			...(channel?.guild_id === undefined ? {} : { guildId: channel.guild_id }),
			author,
			content,
			embeds: arrayValue(raw.embeds),
			components: arrayValue(raw.components),
			attachments: normalizeAttachments(raw.attachments),
			flags: numberValue(raw.flags),
		});
		const derived = this.deriveMentions(content, raw.allowed_mentions);
		message.mention_everyone = derived.mention_everyone;
		message.mentions = derived.mentions;
		message.mention_roles = derived.mention_roles;
		if ('message_reference' in raw && raw.message_reference) {
			const ref = asRecord(raw.message_reference);
			message.message_reference = {
				...(stringValue(ref.message_id) === undefined ? {} : { message_id: stringValue(ref.message_id) }),
				...(stringValue(ref.channel_id) === undefined ? {} : { channel_id: stringValue(ref.channel_id) }),
				...(numberValue(ref.type) === undefined ? {} : { type: numberValue(ref.type) }),
			};
			const referencedId = stringValue(ref.message_id);
			const referenced = referencedId
				? this.world.messages.find(entry => entry.message.id === referencedId)?.message
				: undefined;
			if (referenced && numberValue(ref.type) === 1) {
				message.message_snapshots = [
					{
						message: {
							content: referenced.content,
							embeds: referenced.embeds,
							attachments: referenced.attachments,
							type: referenced.type,
						},
					},
				];
			} else if (referenced) {
				message.referenced_message = referenced;
			}
		}
		if ('poll' in raw && raw.poll) {
			const poll = normalizePoll(asRecord(raw.poll));
			message.poll = poll;
			const voters = new Map<number, Set<string>>();
			for (const answer of poll.answers) voters.set(answer.answer_id, new Set());
			this.pollVotersByMessage.set(this.reactionKey(channelId, message.id), voters);
		}
		this.world.messages.push({ channelId, message });
		return this.buildMessageView(message);
	}

	/** @internal When Discord edits a message. */
	editMessage(channelId: string, messageId: string, raw: Record<string, unknown>): void {
		assertSendableMessage(raw, 'edit');
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		if ('content' in raw && raw.content !== undefined) entry.message.content = stringValue(raw.content) ?? '';
		if (raw.embeds !== undefined) entry.message.embeds = arrayValue(raw.embeds);
		if (raw.components !== undefined) entry.message.components = arrayValue(raw.components);
		if ('attachments' in raw && raw.attachments !== undefined)
			entry.message.attachments = normalizeAttachments(raw.attachments);
		if (raw.flags !== undefined) entry.message.flags = numberValue(raw.flags) ?? entry.message.flags;
	}

	/** @internal When Discord deletes a message. */
	deleteMessage(channelId: string, messageId: string): void {
		this.world.messages = this.world.messages.filter(
			message => message.channelId !== channelId || message.message.id !== messageId,
		);
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
		this.pollVotersByMessage.delete(this.reactionKey(channelId, messageId));
		const pinned = this.pinnedByChannel.get(channelId);
		if (pinned) {
			const next = pinned.filter(id => id !== messageId);
			if (next.length === 0) this.pinnedByChannel.delete(channelId);
			else this.pinnedByChannel.set(channelId, next);
		}
		for (const [token, id] of this.messageIdByToken) {
			if (id === messageId) this.messageIdByToken.delete(token);
		}
	}

	private reactionKey(channelId: string, messageId: string): string {
		return `${channelId}:${messageId}`;
	}

	/** @internal When a user reacts to a message. */
	addReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const decoded = decodeEmoji(emoji);
		const byEmoji = this.reactionsByMessage.get(key) ?? new Map<string, Set<string>>();
		const users = byEmoji.get(decoded) ?? new Set<string>();
		users.add(userId);
		byEmoji.set(decoded, users);
		this.reactionsByMessage.set(key, byEmoji);
	}

	/** @internal When a user removes their reaction. */
	removeReaction(channelId: string, messageId: string, emoji: string, userId: string): void {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return;
		const decoded = decodeEmoji(emoji);
		const users = byEmoji.get(decoded);
		if (!users) return;
		users.delete(userId);
		if (users.size === 0) byEmoji.delete(decoded);
	}

	/** @internal When all reactions are purged from a message. */
	removeAllReactions(channelId: string, messageId: string): void {
		this.reactionsByMessage.delete(this.reactionKey(channelId, messageId));
	}

	/** @internal When one emoji's reactions are purged. */
	removeEmojiReactions(channelId: string, messageId: string, emoji: string): void {
		this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.delete(decodeEmoji(emoji));
	}

	/** The user ids who reacted to a message with a given emoji. */
	reactionUsers(channelId: string, messageId: string, emoji: string): string[] {
		const users = this.reactionsByMessage.get(this.reactionKey(channelId, messageId))?.get(decodeEmoji(emoji));
		return users ? [...users] : [];
	}

	private reactionViews(channelId: string, messageId: string): ReactionView[] {
		const byEmoji = this.reactionsByMessage.get(this.reactionKey(channelId, messageId));
		if (!byEmoji) return [];
		return [...byEmoji].map(([emoji, users]) => ({
			emoji,
			count: users.size,
			me: users.has(TEST_BOT_ID),
			users: [...users],
		}));
	}

	/** @internal When Discord adds a member. Idempotent (replace-or-push). */
	addMember(guildId: string, raw: Record<string, unknown>): void {
		const rawUser = asRecord(raw.user);
		const userId = stringValue(rawUser.id);
		if (!userId) return;
		const disabledUntil = stringValue(raw.communication_disabled_until);
		const member = apiMember({
			user: { ...apiUser({ id: userId }), ...rawUser } as ApiUser,
			roles: arrayValue(raw.roles).map(String),
			nick: stringValue(raw.nick) ?? null,
			...(disabledUntil === undefined ? {} : { communicationDisabledUntil: disabledUntil }),
		});
		const existing = this.world.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId);
		if (existing) existing.member = member;
		else this.world.members.push({ guildId, member });
	}

	/** @internal When Discord removes a member. */
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

	/** @internal When Discord lifts a ban. */
	unban(guildId: string, userId: string): void {
		this.bansByGuild.get(guildId)?.delete(userId);
	}

	/** The user ids currently banned in a guild. */
	bans(guildId: string): string[] {
		return [...(this.bansByGuild.get(guildId) ?? new Set<string>())];
	}

	/** @internal When Discord edits a channel. */
	editChannel(channelId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 1, 100, 'channel name');
		if ('topic' in patch) assertNameBounds(patch.topic, 0, 1024, 'channel topic');
		if ('name' in patch) channel.name = stringValue(patch.name) ?? channel.name;
		if ('type' in patch && numberValue(patch.type) !== undefined) channel.type = numberValue(patch.type)!;
		if ('parent_id' in patch) channel.parent_id = stringValue(patch.parent_id);
		if ('permission_overwrites' in patch)
			channel.permission_overwrites = normalizeOverwrites(patch.permission_overwrites);
		if ('topic' in patch) channel.topic = stringValue(patch.topic) ?? null;
		if ('nsfw' in patch && typeof patch.nsfw === 'boolean') channel.nsfw = patch.nsfw;
		if ('rate_limit_per_user' in patch && numberValue(patch.rate_limit_per_user) !== undefined)
			channel.rate_limit_per_user = numberValue(patch.rate_limit_per_user)!;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			channel.position = numberValue(patch.position)!;
		if ('bitrate' in patch && numberValue(patch.bitrate) !== undefined) channel.bitrate = numberValue(patch.bitrate)!;
		if ('user_limit' in patch && numberValue(patch.user_limit) !== undefined)
			channel.user_limit = numberValue(patch.user_limit)!;
		if (channel.thread_metadata) {
			if ('archived' in patch && typeof patch.archived === 'boolean') channel.thread_metadata.archived = patch.archived;
			if ('locked' in patch && typeof patch.locked === 'boolean') channel.thread_metadata.locked = patch.locked;
			if ('auto_archive_duration' in patch && numberValue(patch.auto_archive_duration) !== undefined)
				channel.thread_metadata.auto_archive_duration = numberValue(patch.auto_archive_duration)!;
		}
		return { ...channel };
	}

	/** @internal When Discord pins a message. Idempotent. */
	pinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry) return;
		entry.message.pinned = true;
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		if (!ids.includes(messageId)) ids.unshift(messageId);
		this.pinnedByChannel.set(channelId, ids);
	}

	/** @internal When Discord unpins a message. */
	unpinMessage(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (entry) entry.message.pinned = false;
		const ids = this.pinnedByChannel.get(channelId);
		if (!ids) return;
		const next = ids.filter(id => id !== messageId);
		if (next.length === 0) this.pinnedByChannel.delete(channelId);
		else this.pinnedByChannel.set(channelId, next);
	}

	/** The pinned messages of a channel, newest pin first. */
	pins(channelId: string): RawMessage[] {
		const ids = this.pinnedByChannel.get(channelId) ?? [];
		return ids.map(id => this.rawMessage(channelId, id)).filter((message): message is RawMessage => !!message);
	}

	/** The archived threads under a channel of the given type (public = 11, private = 12). */
	archivedThreads(channelId: string, type: 'public' | 'private'): ApiChannel[] {
		const threadType = type === 'private' ? 12 : 11;
		return this.world.channels
			.filter(
				channel =>
					channel.parent_id === channelId && channel.type === threadType && channel.thread_metadata?.archived === true,
			)
			.map(channel => ({ ...channel }));
	}

	/** @internal Records a vote on a poll answer; the mock exposes this via `bot.seedPollVote`. */
	addPollVoter(channelId: string, messageId: string, answerId: number, userId: string): void {
		const key = this.reactionKey(channelId, messageId);
		const byAnswer = this.pollVotersByMessage.get(key) ?? new Map<number, Set<string>>();
		const voters = byAnswer.get(answerId) ?? new Set<string>();
		voters.add(userId);
		byAnswer.set(answerId, voters);
		this.pollVotersByMessage.set(key, byAnswer);
		this.recountPoll(channelId, messageId);
	}

	private recountPoll(channelId: string, messageId: string): void {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		const poll = entry?.message.poll;
		if (!poll) return;
		const byAnswer = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId));
		poll.results.answer_counts = poll.answers.map(answer => {
			const voters = byAnswer?.get(answer.answer_id);
			return { id: answer.answer_id, count: voters?.size ?? 0, me_voted: voters?.has(TEST_BOT_ID) ?? false };
		});
	}

	/** @internal When Discord finalizes a poll. */
	finalizePoll(channelId: string, messageId: string): RawMessage | undefined {
		const entry = this.world.messages.find(
			message => message.channelId === channelId && message.message.id === messageId,
		);
		if (!entry?.message.poll) return undefined;
		this.recountPoll(channelId, messageId);
		entry.message.poll.results.is_finalized = true;
		return this.rawMessage(channelId, messageId);
	}

	/** The user ids who voted for a poll answer. */
	pollVoters(channelId: string, messageId: string, answerId: number): string[] {
		const voters = this.pollVotersByMessage.get(this.reactionKey(channelId, messageId))?.get(answerId);
		return voters ? [...voters] : [];
	}

	/** @internal When Discord rewrites member roles. */
	setMemberRoles(guildId: string, userId: string, roles: string[]): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (entry) entry.member.roles = [...roles];
	}

	/** @internal When Discord PATCHes a member. */
	patchMember(
		guildId: string,
		userId: string,
		patch: { nick?: string | null; roles?: string[]; communication_disabled_until?: string | null },
	): void {
		const entry = this.world.members.find(member => member.guildId === guildId && member.member.user.id === userId);
		if (!entry) return;
		if ('nick' in patch) assertNameBounds(patch.nick, 0, 32, 'nickname');
		if ('nick' in patch) entry.member.nick = patch.nick ?? null;
		if (patch.roles) entry.member.roles = [...patch.roles];
		if ('communication_disabled_until' in patch) {
			entry.member.communication_disabled_until = patch.communication_disabled_until;
		}
	}

	/** @internal When Discord creates a role. */
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

	/** @internal When Discord edits a role. */
	editRole(guildId: string, roleId: string, patch: Record<string, unknown>): ApiRole | undefined {
		const entry = this.world.roles.find(role => role.guildId === guildId && role.role.id === roleId);
		if (!entry) return undefined;
		if ('name' in patch) entry.role.name = stringValue(patch.name) ?? entry.role.name;
		if ('permissions' in patch) entry.role.permissions = stringValue(patch.permissions) ?? entry.role.permissions;
		if ('position' in patch && numberValue(patch.position) !== undefined)
			entry.role.position = numberValue(patch.position)!;
		if ('color' in patch && numberValue(patch.color) !== undefined) entry.role.color = numberValue(patch.color)!;
		return { ...entry.role };
	}

	/** @internal When Discord deletes a role. */
	removeRole(guildId: string, roleId: string): void {
		this.world.roles = this.world.roles.filter(entry => entry.guildId !== guildId || entry.role.id !== roleId);
	}

	/** @internal When Discord creates an emoji. */
	addEmoji(guildId: string, raw: Record<string, unknown>): ApiEmoji {
		assertNameBounds(raw.name, 2, 32, 'emoji name', /^[A-Za-z0-9_]+$/);
		const emoji = apiEmoji({
			id: stringValue(raw.id),
			name: stringValue(raw.name),
			guildId,
			...(typeof raw.animated === 'boolean' ? { animated: raw.animated } : {}),
			roles: arrayValue(raw.roles).map(String),
		});
		(this.world.guildEmojis ??= []).push({ guildId, emoji });
		return emoji;
	}

	/** @internal When Discord edits an emoji. */
	editEmoji(guildId: string, emojiId: string, patch: Record<string, unknown>): ApiEmoji | undefined {
		const entry = (this.world.guildEmojis ?? []).find(e => e.guildId === guildId && e.emoji.id === emojiId);
		if (!entry) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 32, 'emoji name', /^[A-Za-z0-9_]+$/);
		if ('name' in patch) entry.emoji.name = stringValue(patch.name) ?? entry.emoji.name;
		if ('roles' in patch) entry.emoji.roles = arrayValue(patch.roles).map(String);
		return { ...entry.emoji };
	}

	/** @internal When Discord deletes an emoji. */
	removeEmoji(guildId: string, emojiId: string): void {
		this.world.guildEmojis = (this.world.guildEmojis ?? []).filter(
			e => e.guildId !== guildId || e.emoji.id !== emojiId,
		);
	}

	/** The custom emojis of a guild. */
	emojis(guildId: string): ApiEmoji[] {
		return (this.world.guildEmojis ?? []).filter(e => e.guildId === guildId).map(e => e.emoji);
	}

	/** A single guild emoji by id. */
	emoji(guildId: string, emojiId: string): ApiEmoji | undefined {
		return (this.world.guildEmojis ?? []).find(e => e.guildId === guildId && e.emoji.id === emojiId)?.emoji;
	}

	/** @internal When Discord creates an invite. */
	addInvite(channelId: string, guildId: string | undefined, raw: Record<string, unknown>): ApiInvite {
		const invite = apiInvite({
			code: stringValue(raw.code),
			channelId,
			...(guildId === undefined ? {} : { guildId }),
			...(numberValue(raw.max_uses) === undefined ? {} : { maxUses: numberValue(raw.max_uses) }),
			...(numberValue(raw.max_age) === undefined ? {} : { maxAge: numberValue(raw.max_age) }),
		});
		this.invitesByCode.set(invite.code, invite);
		return invite;
	}

	/** @internal When Discord revokes an invite. */
	removeInvite(code: string): ApiInvite | undefined {
		const invite = this.invitesByCode.get(code);
		this.invitesByCode.delete(code);
		return invite;
	}

	/** Every invite in the world. */
	invites(): ApiInvite[] {
		return [...this.invitesByCode.values()];
	}

	/** A single invite by code. */
	invite(code: string): ApiInvite | undefined {
		return this.invitesByCode.get(code);
	}

	/** The invites pointing at a channel. */
	channelInvites(channelId: string): ApiInvite[] {
		return [...this.invitesByCode.values()].filter(invite => invite.channel_id === channelId);
	}

	/** The invites of a guild. */
	guildInvites(guildId: string): ApiInvite[] {
		return [...this.invitesByCode.values()].filter(invite => invite.guild_id === guildId);
	}

	/** @internal When Discord creates an automod rule. */
	addAutoModRule(guildId: string, raw: Record<string, unknown>): ApiAutoModRule {
		const rule = apiAutoModRule({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(numberValue(raw.trigger_type) === undefined ? {} : { triggerType: numberValue(raw.trigger_type) }),
			...(numberValue(raw.event_type) === undefined ? {} : { eventType: numberValue(raw.event_type) }),
			...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
			...(raw.trigger_metadata === undefined
				? {}
				: { triggerMetadata: asRecord(raw.trigger_metadata) as AutoModTriggerMetadata }),
			actions: arrayValue(raw.actions) as AutoModAction[],
		});
		(this.world.autoModRules ??= []).push({ guildId, rule });
		return rule;
	}

	/** @internal When Discord edits an automod rule. */
	editAutoModRule(guildId: string, ruleId: string, patch: Record<string, unknown>): ApiAutoModRule | undefined {
		const entry = (this.world.autoModRules ?? []).find(r => r.guildId === guildId && r.rule.id === ruleId);
		if (!entry) return undefined;
		if ('name' in patch) entry.rule.name = stringValue(patch.name) ?? entry.rule.name;
		if (typeof patch.enabled === 'boolean') entry.rule.enabled = patch.enabled;
		if (numberValue(patch.trigger_type) !== undefined) entry.rule.trigger_type = numberValue(patch.trigger_type)!;
		if (numberValue(patch.event_type) !== undefined) entry.rule.event_type = numberValue(patch.event_type)!;
		if ('actions' in patch) entry.rule.actions = arrayValue(patch.actions) as AutoModAction[];
		return { ...entry.rule };
	}

	/** @internal When Discord deletes an automod rule. */
	removeAutoModRule(guildId: string, ruleId: string): void {
		this.world.autoModRules = (this.world.autoModRules ?? []).filter(
			r => r.guildId !== guildId || r.rule.id !== ruleId,
		);
	}

	/** The automod rules of a guild. */
	autoModRules(guildId: string): ApiAutoModRule[] {
		return (this.world.autoModRules ?? []).filter(r => r.guildId === guildId).map(r => r.rule);
	}

	/** A single automod rule by id. */
	autoModRule(guildId: string, ruleId: string): ApiAutoModRule | undefined {
		return (this.world.autoModRules ?? []).find(r => r.guildId === guildId && r.rule.id === ruleId)?.rule;
	}

	/** @internal When a user joins a thread. Idempotent. */
	addThreadMember(channelId: string, userId: string): void {
		const set = this.threadMembersByChannel.get(channelId) ?? new Set<string>();
		set.add(userId);
		this.threadMembersByChannel.set(channelId, set);
	}

	/** @internal When a user leaves a thread. */
	removeThreadMember(channelId: string, userId: string): void {
		const set = this.threadMembersByChannel.get(channelId);
		if (!set) return;
		set.delete(userId);
		if (set.size === 0) this.threadMembersByChannel.delete(channelId);
	}

	/** The user ids currently in a thread. */
	threadMembers(channelId: string): string[] {
		return [...(this.threadMembersByChannel.get(channelId) ?? new Set<string>())];
	}

	/** The non-archived threads of a guild (the active set). */
	activeThreads(guildId: string): ApiChannel[] {
		return this.world.channels
			.filter(
				channel =>
					channel.guild_id === guildId &&
					channel.thread_metadata !== undefined &&
					channel.thread_metadata.archived !== true,
			)
			.map(channel => ({ ...channel }));
	}

	/** @internal When Discord creates a webhook. */
	registerWebhook(options: Parameters<typeof apiWebhook>[0]): ApiWebhook {
		const webhook = apiWebhook(options);
		this.webhooksById.set(webhook.id, webhook);
		return webhook;
	}

	/** @internal When Discord edits a webhook. */
	editWebhook(id: string, patch: Record<string, unknown>): ApiWebhook | undefined {
		const webhook = this.webhooksById.get(id);
		if (!webhook) return undefined;
		if ('name' in patch) webhook.name = stringValue(patch.name) ?? webhook.name;
		if ('channel_id' in patch) webhook.channel_id = stringValue(patch.channel_id) ?? webhook.channel_id;
		return { ...webhook };
	}

	/** @internal When Discord deletes a webhook. */
	removeWebhook(id: string): void {
		this.webhooksById.delete(id);
	}

	/** A webhook by id. */
	webhookById(id: string): ApiWebhook | undefined {
		return this.webhooksById.get(id);
	}

	/** The webhooks of a guild. */
	webhooksForGuild(guildId: string): ApiWebhook[] {
		return [...this.webhooksById.values()].filter(webhook => webhook.guild_id === guildId);
	}

	/** The webhooks of a channel. */
	webhooksForChannel(channelId: string): ApiWebhook[] {
		return [...this.webhooksById.values()].filter(webhook => webhook.channel_id === channelId);
	}

	/** @internal When Discord creates a sticker. */
	addSticker(guildId: string, raw: Record<string, unknown>): ApiSticker {
		assertNameBounds(raw.name, 2, 30, 'sticker name');
		const sticker = apiSticker({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(stringValue(raw.tags) === undefined ? {} : { tags: stringValue(raw.tags) }),
			...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		});
		(this.world.guildStickers ??= []).push({ guildId, sticker });
		return sticker;
	}

	/** @internal When Discord edits a sticker. */
	editSticker(guildId: string, stickerId: string, patch: Record<string, unknown>): ApiSticker | undefined {
		const entry = (this.world.guildStickers ?? []).find(s => s.guildId === guildId && s.sticker.id === stickerId);
		if (!entry) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 30, 'sticker name');
		if ('name' in patch) entry.sticker.name = stringValue(patch.name) ?? entry.sticker.name;
		if ('tags' in patch) entry.sticker.tags = stringValue(patch.tags) ?? entry.sticker.tags;
		if ('description' in patch) entry.sticker.description = stringValue(patch.description) ?? null;
		return { ...entry.sticker };
	}

	/** @internal When Discord deletes a sticker. */
	removeSticker(guildId: string, stickerId: string): void {
		this.world.guildStickers = (this.world.guildStickers ?? []).filter(
			s => s.guildId !== guildId || s.sticker.id !== stickerId,
		);
	}

	/** The custom stickers of a guild. */
	stickers(guildId: string): ApiSticker[] {
		return (this.world.guildStickers ?? []).filter(s => s.guildId === guildId).map(s => s.sticker);
	}

	/** A single guild sticker by id. */
	sticker(guildId: string, stickerId: string): ApiSticker | undefined {
		return (this.world.guildStickers ?? []).find(s => s.guildId === guildId && s.sticker.id === stickerId)?.sticker;
	}

	/** @internal When Discord creates a scheduled event. */
	addScheduledEvent(guildId: string, raw: Record<string, unknown>): ApiScheduledEvent {
		const event = apiScheduledEvent({
			id: stringValue(raw.id),
			guildId,
			name: stringValue(raw.name),
			...(stringValue(raw.channel_id) === undefined ? {} : { channelId: stringValue(raw.channel_id) }),
			...(stringValue(raw.scheduled_start_time) === undefined
				? {}
				: { scheduledStartTime: stringValue(raw.scheduled_start_time) }),
			...(numberValue(raw.entity_type) === undefined ? {} : { entityType: numberValue(raw.entity_type) }),
		});
		(this.world.scheduledEvents ??= []).push({ guildId, event });
		return event;
	}

	/** @internal When Discord deletes a scheduled event. */
	removeScheduledEvent(guildId: string, eventId: string): void {
		this.world.scheduledEvents = (this.world.scheduledEvents ?? []).filter(
			e => e.guildId !== guildId || e.event.id !== eventId,
		);
	}

	/** The scheduled events of a guild. */
	scheduledEvents(guildId: string): ApiScheduledEvent[] {
		return (this.world.scheduledEvents ?? []).filter(e => e.guildId === guildId).map(e => e.event);
	}

	/** A single scheduled event by id. */
	scheduledEvent(guildId: string, eventId: string): ApiScheduledEvent | undefined {
		return (this.world.scheduledEvents ?? []).find(e => e.guildId === guildId && e.event.id === eventId)?.event;
	}

	/** @internal When Discord creates a guild template. */
	addGuildTemplate(guildId: string, raw: Record<string, unknown>): ApiGuildTemplate {
		const template = apiGuildTemplate({
			code: stringValue(raw.code),
			name: stringValue(raw.name),
			sourceGuildId: guildId,
			...(stringValue(raw.description) === undefined ? {} : { description: stringValue(raw.description) }),
		});
		(this.world.guildTemplates ??= []).push({ guildId, template });
		return template;
	}

	/** The templates of a guild. */
	guildTemplates(guildId: string): ApiGuildTemplate[] {
		return (this.world.guildTemplates ?? []).filter(t => t.guildId === guildId).map(t => t.template);
	}

	/** A guild template by code. */
	guildTemplate(code: string): ApiGuildTemplate | undefined {
		return (this.world.guildTemplates ?? []).find(t => t.template.code === code)?.template;
	}

	/** The soundboard sounds of a guild. */
	soundboardSounds(guildId: string): ApiSoundboardSound[] {
		return (this.world.soundboardSounds ?? []).filter(s => s.guildId === guildId).map(s => s.sound);
	}

	/** @internal When Discord creates a stage instance. */
	addStageInstance(raw: Record<string, unknown>): ApiStageInstance {
		const channelId = stringValue(raw.channel_id) ?? mockId();
		const guildId = this.world.channels.find(channel => channel.id === channelId)?.guild_id;
		const stage = apiStageInstance({
			channelId,
			...(guildId === undefined ? {} : { guildId }),
			...(stringValue(raw.topic) === undefined ? {} : { topic: stringValue(raw.topic) }),
			...(numberValue(raw.privacy_level) === undefined ? {} : { privacyLevel: numberValue(raw.privacy_level) }),
		});
		this.world.stageInstances = [
			...(this.world.stageInstances ?? []).filter(entry => entry.channel_id !== channelId),
			stage,
		];
		return stage;
	}

	/** @internal When Discord deletes a stage instance. */
	removeStageInstance(channelId: string): void {
		this.world.stageInstances = (this.world.stageInstances ?? []).filter(entry => entry.channel_id !== channelId);
	}

	/** The live stage instance of a stage channel, if any. */
	stageInstance(channelId: string): ApiStageInstance | undefined {
		return (this.world.stageInstances ?? []).find(entry => entry.channel_id === channelId);
	}

	/** The audit log entries of a guild. */
	auditLogEntries(guildId: string): ApiAuditLogEntry[] {
		return (this.world.auditLogEntries ?? []).filter(e => e.guildId === guildId).map(e => e.entry);
	}

	/** @internal When Discord edits a guild. */
	editGuild(guildId: string, patch: Record<string, unknown>): Record<string, unknown> | undefined {
		const guild = this.world.guilds.find(entry => entry.id === guildId);
		if (!guild) return undefined;
		if ('name' in patch) assertNameBounds(patch.name, 2, 100, 'guild name');
		if ('name' in patch) guild.name = stringValue(patch.name) ?? guild.name;
		return { ...guild };
	}

	/** Whether a user is currently banned in a guild. */
	isBanned(guildId: string, userId: string): boolean {
		return this.bansByGuild.get(guildId)?.has(userId) ?? false;
	}

	/** @internal When Discord sets a channel permission overwrite. */
	setChannelOverwrite(channelId: string, overwriteId: string, overwrite: Record<string, unknown>): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		const next: ChannelOverwriteLike = {
			id: overwriteId,
			type: numberValue(overwrite.type) ?? 0,
			allow: stringValue(overwrite.allow) ?? '0',
			deny: stringValue(overwrite.deny) ?? '0',
		};
		channel.permission_overwrites = [
			...channel.permission_overwrites.filter(current => current.id !== overwriteId),
			next,
		];
	}

	/** @internal When Discord removes a channel permission overwrite. */
	removeChannelOverwrite(channelId: string, overwriteId: string): void {
		const channel = this.world.channels.find(entry => entry.id === channelId);
		if (!channel) return;
		channel.permission_overwrites = channel.permission_overwrites.filter(current => current.id !== overwriteId);
	}

	/** @internal For an interaction's first visible reply. */
	addOriginalResponse(token: string, channelId: string, raw: Record<string, unknown>, authorId: string): RawMessage {
		this.registerInteractionToken(token, channelId);
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		this.messageIdByToken.set(token, view.id);
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal For webhook edits of @original. */
	upsertOriginalResponse(
		token: string,
		raw: Record<string, unknown>,
		authorId: string,
	): RawMessage | Record<string, never> {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const messageId = this.messageIdByToken.get(token);
		if (!messageId) return this.addOriginalResponse(token, channelId, raw, authorId);
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal For webhook edits of any interaction message. */
	editWebhookMessage(
		token: string,
		messageId: string,
		raw: Record<string, unknown>,
		authorId: string,
	): RawMessage | Record<string, never> {
		if (messageId === '@original') return this.upsertOriginalResponse(token, raw, authorId);
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		this.editMessage(channelId, messageId, raw);
		return this.rawMessageOr(channelId, messageId);
	}

	/** @internal For webhook followups. */
	addFollowup(token: string, raw: Record<string, unknown>, authorId: string): RawMessage | Record<string, never> {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownWebhook, 'Unknown Webhook');
		const channelId = this.channelIdByToken.get(token);
		if (!channelId) return {};
		const view = this.addMessage(channelId, { ...raw, author_id: authorId });
		return this.rawMessageOr(channelId, view.id);
	}

	/** @internal For webhook deletes of @original. */
	deleteOriginalResponse(token: string): void {
		if (!this.acknowledgedTokens.has(token)) apiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
		const channelId = this.channelIdByToken.get(token);
		const messageId = this.messageIdByToken.get(token);
		if (channelId && messageId) this.deleteMessage(channelId, messageId);
		this.messageIdByToken.delete(token);
	}

	/** @internal For webhook deletes of any interaction message. */
	deleteWebhookMessage(token: string, messageId: string): void {
		if (messageId === '@original') {
			this.deleteOriginalResponse(token);
			return;
		}
		const channelId = this.channelIdByToken.get(token);
		if (channelId) this.deleteMessage(channelId, messageId);
	}

	private channelView(channel: ApiChannel): ChannelView {
		const channelMessages = this.world.messages.filter(
			message => message.channelId === channel.id && !isEphemeral(message.message),
		);
		const messages = channelMessages.map(message => this.buildMessageView(message.message));
		const pinnedIds = this.pinnedByChannel.get(channel.id) ?? [];
		const pins = pinnedIds
			.map(id => channelMessages.find(message => message.message.id === id))
			.filter((entry): entry is (typeof channelMessages)[number] => !!entry)
			.map(entry => this.buildMessageView(entry.message));
		return {
			id: channel.id,
			name: channel.name,
			type: channel.type,
			parentId: channel.parent_id,
			...(channel.topic === undefined ? {} : { topic: channel.topic }),
			nsfw: channel.nsfw,
			...(channel.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: channel.rate_limit_per_user }),
			position: channel.position,
			...(channel.thread_metadata === undefined
				? {}
				: {
						archived: channel.thread_metadata.archived,
						locked: channel.thread_metadata.locked,
						threadMetadata: channel.thread_metadata,
					}),
			overwrites: channel.permission_overwrites.map(overwrite => ({ ...overwrite })),
			messages,
			lastMessage: messages.at(-1),
			pins,
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

	private buildMessageView(message: ApiMessage): MessageView {
		const { buttons, componentTypes, textDisplays } = harvestComponents(message.components);
		const reactions = this.reactionViews(message.channel_id, message.id);
		return {
			id: message.id,
			channelId: message.channel_id,
			authorId: message.author.id,
			content: message.content,
			embeds: message.embeds.map(normalizeEmbed),
			components: [...message.components],
			isComponentsV2: (message.flags & MESSAGE_FLAG_COMPONENTS_V2) !== 0,
			componentTypes,
			textDisplays,
			attachments: message.attachments.map(attachment => ({
				id: attachment.id,
				filename: attachment.filename,
				contentType: attachment.content_type,
				size: attachment.size,
				url: attachment.url,
			})),
			snapshots: (message.message_snapshots ?? []).map(snapshot => {
				const snapMessage = asRecord(snapshot.message);
				return {
					...(typeof snapMessage.content === 'string' ? { content: snapMessage.content } : {}),
					embeds: arrayValue(snapMessage.embeds).map(normalizeEmbed),
				};
			}),
			buttons,
			button: labelOrCustomId =>
				buttons.find(button => button.label === labelOrCustomId || button.customId === labelOrCustomId),
			reactions,
			reaction: emoji => reactions.find(entry => entry.emoji === decodeEmoji(emoji)),
			...(message.message_reference === undefined
				? {}
				: {
						reference: {
							...(message.message_reference.message_id === undefined
								? {}
								: { messageId: message.message_reference.message_id }),
							...(message.message_reference.channel_id === undefined
								? {}
								: { channelId: message.message_reference.channel_id }),
							...(message.message_reference.type === undefined ? {} : { type: message.message_reference.type }),
						},
					}),
			...(message.referenced_message === undefined
				? {}
				: {
						referencedMessage: {
							id: message.referenced_message.id,
							channelId: message.referenced_message.channel_id,
							authorId: message.referenced_message.author?.id,
							content: message.referenced_message.content,
						},
					}),
			...(message.poll === undefined
				? {}
				: {
						poll: {
							...(message.poll.question.text === undefined ? {} : { question: message.poll.question.text }),
							answers: message.poll.answers.map(answer => ({
								answerId: answer.answer_id,
								...(answer.poll_media.text === undefined ? {} : { text: answer.poll_media.text }),
							})),
							isFinalized: message.poll.results.is_finalized,
						},
					}),
		};
	}
}
