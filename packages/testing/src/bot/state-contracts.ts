import {
	type ApiAuditLogEntry,
	type ApiAutoModRule,
	type ApiEmoji,
	type ApiGuildTemplate,
	type ApiInvite,
	type ApiScheduledEvent,
	type ApiSoundboardSound,
	type ApiStageInstance,
	type ApiSticker,
	type ApiUser,
	type ApiVoiceState,
	type ApiWebhook,
	type RawMessage,
	type ThreadMetadata,
} from './payloads';

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

export interface InteractiveComponentView {
	customId?: string;
	label?: string;
	type: number;
	disabled?: boolean;
	/** Select-menu choices (string selects), each with its label/value when present. */
	options?: { label?: string; value?: string }[];
}

export interface ReactionView {
	channelId: string;
	messageId: string;
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
	guildId?: string;
	authorId?: string;
	content?: string;
	embeds: EmbedView[];
	components: unknown[];
	attachments: AttachmentView[];
	isComponentsV2: boolean;
	componentTypes: number[];
	textDisplays: string[];
	interactiveComponents: InteractiveComponentView[];
	component(labelOrCustomId: string): InteractiveComponentView | undefined;
	reactions: ReactionView[];
	reaction(emoji: string): ReactionView | undefined;
	reference?: MessageReferenceView;
	referencedMessage?: { id: string; channelId: string; authorId?: string; content?: string };
	snapshots: { content?: string; embeds: EmbedView[] }[];
	poll?: { question?: string; answers: { answerId: number; text?: string }[]; isFinalized: boolean };
}

export interface ChannelView {
	id: string;
	guildId?: string;
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
	guildId: string;
	userId: string;
	roles: string[];
	nick?: string | null;
	communicationDisabledUntil?: string | null;
}

/** Role projection returned by guild/role readers; carries the stored permissions and color, not just identity. */
export interface RoleView {
	guildId: string;
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
	threads: ChannelView[];
	members: GuildMemberView[];
	roles: RoleView[];
	bans: string[];
	emojis: { id: string; name: string }[];
	invites: { code: string; channelId: string; uses: number }[];
	autoModRules: ApiAutoModRule[];
	stickers: { id: string; name: string }[];
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
	topic?: string | null;
	nsfw?: boolean;
	position?: number;
	rateLimitPerUser?: number;
	archived?: boolean;
	locked?: boolean;
	bitrate?: number;
	userLimit?: number;
	autoArchiveDuration?: number;
}

/** One message captured in a {@link WorldSnapshot}, identified by `id`. */
export interface MessageSnapshot {
	id: string;
	channelId: string;
	authorId: string;
	content: string;
	embeds: unknown[];
	components: unknown[];
	flags: number;
	pinned: boolean;
}

/** One reaction-user captured in a {@link WorldSnapshot}, identified by channel+message+emoji+user. */
export interface ReactionSnapshot {
	channelId: string;
	messageId: string;
	emoji: string;
	userId: string;
}

/** One voice state captured in a {@link WorldSnapshot}, identified by `guildId` + `userId`. */
export interface VoiceStateSnapshot {
	guildId: string;
	userId: string;
	channelId: string | null;
}

/** One thread membership captured in a {@link WorldSnapshot}, identified by `channelId` + `userId`. */
export interface ThreadMemberSnapshot {
	channelId: string;
	userId: string;
}

/** One poll vote captured in a {@link WorldSnapshot}, identified by channel+message+answer+user. */
export interface PollVoterSnapshot {
	channelId: string;
	messageId: string;
	answerId: number;
	userId: string;
}

/** One role captured in a {@link WorldSnapshot}, identified by `id`. */
export interface RoleSnapshot {
	guildId: string;
	id: string;
	name: string;
	permissions: string;
	position: number;
	color?: number;
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
	roles?: string[];
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
	triggerType?: number;
	eventType?: number;
	actions?: unknown[];
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
	reactions: ReactionSnapshot[];
	voiceStates: VoiceStateSnapshot[];
	threadMembers: ThreadMemberSnapshot[];
	pollVoters: PollVoterSnapshot[];
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
	reactions: EntityDiff<ReactionSnapshot>;
	voiceStates: EntityDiff<VoiceStateSnapshot>;
	threadMembers: EntityDiff<ThreadMemberSnapshot>;
	pollVoters: EntityDiff<PollVoterSnapshot>;
}

export interface WorldStateOptions {
	botId?: string;
}

export type RequireAtLeastOne<T extends object> = {
	[K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

export interface WorldStateCandidate {
	path: string;
	summary?: string;
}

export interface WorldGuildFilter {
	id?: string;
	name?: string;
}
export type WorldGuildQuery = RequireAtLeastOne<WorldGuildFilter>;

export interface WorldChannelFilter {
	id?: string;
	guildId?: string;
	name?: string;
	parentId?: string;
	type?: number;
	archived?: boolean;
	locked?: boolean;
}
export type WorldChannelQuery = RequireAtLeastOne<WorldChannelFilter>;
export type WorldThreadFilter = WorldChannelFilter;
export type WorldThreadQuery = RequireAtLeastOne<WorldThreadFilter>;

export interface WorldDmFilter {
	channelId?: string;
	userId?: string;
}
export type WorldDmQuery = RequireAtLeastOne<WorldDmFilter>;

export interface WorldMemberFilter {
	guildId?: string;
	userId?: string;
	roleId?: string;
	nick?: string | null;
}
export type WorldMemberQuery = RequireAtLeastOne<WorldMemberFilter>;

export interface WorldRoleFilter {
	guildId?: string;
	id?: string;
	name?: string;
}
export type WorldRoleQuery = RequireAtLeastOne<WorldRoleFilter>;

export interface WorldMessageFilter {
	channelId?: string;
	id?: string;
	authorId?: string;
	content?: string;
}
export type WorldMessageQuery = RequireAtLeastOne<WorldMessageFilter>;

export interface WorldVoiceStateFilter {
	guildId?: string;
	userId?: string;
	channelId?: string | null;
}
export type WorldVoiceStateQuery = RequireAtLeastOne<WorldVoiceStateFilter>;

export interface WorldBanFilter {
	guildId?: string;
	userId?: string;
}
export type WorldBanQuery = RequireAtLeastOne<WorldBanFilter>;

export interface WorldReactionFilter {
	channelId?: string;
	messageId?: string;
	emoji?: string;
	userId?: string;
}
export type WorldReactionQuery = RequireAtLeastOne<WorldReactionFilter>;

export interface WorldPinFilter {
	channelId?: string;
	messageId?: string;
}
export type WorldPinQuery = RequireAtLeastOne<WorldPinFilter>;

export interface WorldPollVoteFilter {
	channelId?: string;
	messageId?: string;
	answerId?: number;
	userId?: string;
}
export type WorldPollVoteQuery = RequireAtLeastOne<WorldPollVoteFilter>;

export interface WorldThreadMemberFilter {
	channelId?: string;
	userId?: string;
}
export type WorldThreadMemberQuery = RequireAtLeastOne<WorldThreadMemberFilter>;

export interface WorldEmojiFilter {
	guildId?: string;
	id?: string;
	name?: string;
}
export type WorldEmojiQuery = RequireAtLeastOne<WorldEmojiFilter>;

export interface WorldInviteFilter {
	code?: string;
	guildId?: string;
	channelId?: string;
}
export type WorldInviteQuery = RequireAtLeastOne<WorldInviteFilter>;

export interface WorldAutoModRuleFilter {
	guildId?: string;
	id?: string;
	name?: string;
}
export type WorldAutoModRuleQuery = RequireAtLeastOne<WorldAutoModRuleFilter>;

export interface WorldStickerFilter {
	guildId?: string;
	id?: string;
	name?: string;
}
export type WorldStickerQuery = RequireAtLeastOne<WorldStickerFilter>;

export interface WorldScheduledEventFilter {
	guildId?: string;
	id?: string;
	name?: string;
	channelId?: string | null;
}
export type WorldScheduledEventQuery = RequireAtLeastOne<WorldScheduledEventFilter>;

export interface WorldWebhookFilter {
	id?: string;
	guildId?: string;
	channelId?: string;
	name?: string;
}
export type WorldWebhookQuery = RequireAtLeastOne<WorldWebhookFilter>;

export interface WorldGuildTemplateFilter {
	code?: string;
	sourceGuildId?: string;
	name?: string;
}
export type WorldGuildTemplateQuery = RequireAtLeastOne<WorldGuildTemplateFilter>;

export interface WorldSoundboardSoundFilter {
	guildId?: string;
	soundId?: string;
	name?: string;
}
export type WorldSoundboardSoundQuery = RequireAtLeastOne<WorldSoundboardSoundFilter>;

export interface WorldStageInstanceFilter {
	guildId?: string;
	channelId?: string;
	id?: string;
}
export type WorldStageInstanceQuery = RequireAtLeastOne<WorldStageInstanceFilter>;

export interface WorldAuditLogEntryFilter {
	guildId?: string;
	id?: string;
	actionType?: number;
	targetId?: string | null;
	userId?: string | null;
}
export type WorldAuditLogEntryQuery = RequireAtLeastOne<WorldAuditLogEntryFilter>;

export interface WorldGetReader {
	guild(query: WorldGuildQuery): GuildView;
	channel(query: WorldChannelQuery): ChannelView;
	thread(query: WorldThreadQuery): ChannelView;
	dm(query: WorldDmQuery): ChannelView;
	member(query: WorldMemberQuery): GuildMemberView;
	role(query: WorldRoleQuery): RoleView;
	message(query: WorldMessageQuery): MessageView;
	rawMessage(query: WorldMessageQuery): RawMessage;
	voiceState(query: WorldVoiceStateQuery): ApiVoiceState;
	ban(query: WorldBanQuery): BanSnapshot;
	reaction(query: WorldReactionQuery): ReactionView;
	pin(query: WorldPinQuery): MessageView;
	pollVote(query: WorldPollVoteQuery): PollVoterSnapshot;
	threadMember(query: WorldThreadMemberQuery): ThreadMemberSnapshot;
	emoji(query: WorldEmojiQuery): ApiEmoji;
	invite(query: WorldInviteQuery): ApiInvite;
	autoModRule(query: WorldAutoModRuleQuery): ApiAutoModRule;
	sticker(query: WorldStickerQuery): ApiSticker;
	scheduledEvent(query: WorldScheduledEventQuery): ApiScheduledEvent;
	webhook(query: WorldWebhookQuery): ApiWebhook;
	guildTemplate(query: WorldGuildTemplateQuery): ApiGuildTemplate;
	soundboardSound(query: WorldSoundboardSoundQuery): ApiSoundboardSound;
	stageInstance(query: WorldStageInstanceQuery): ApiStageInstance;
	auditLogEntry(query: WorldAuditLogEntryQuery): ApiAuditLogEntry;
}

export interface WorldQueryReader {
	guild(query: WorldGuildQuery): GuildView | undefined;
	channel(query: WorldChannelQuery): ChannelView | undefined;
	thread(query: WorldThreadQuery): ChannelView | undefined;
	dm(query: WorldDmQuery): ChannelView | undefined;
	member(query: WorldMemberQuery): GuildMemberView | undefined;
	role(query: WorldRoleQuery): RoleView | undefined;
	message(query: WorldMessageQuery): MessageView | undefined;
	rawMessage(query: WorldMessageQuery): RawMessage | undefined;
	voiceState(query: WorldVoiceStateQuery): ApiVoiceState | undefined;
	ban(query: WorldBanQuery): BanSnapshot | undefined;
	reaction(query: WorldReactionQuery): ReactionView | undefined;
	pin(query: WorldPinQuery): MessageView | undefined;
	pollVote(query: WorldPollVoteQuery): PollVoterSnapshot | undefined;
	threadMember(query: WorldThreadMemberQuery): ThreadMemberSnapshot | undefined;
	emoji(query: WorldEmojiQuery): ApiEmoji | undefined;
	invite(query: WorldInviteQuery): ApiInvite | undefined;
	autoModRule(query: WorldAutoModRuleQuery): ApiAutoModRule | undefined;
	sticker(query: WorldStickerQuery): ApiSticker | undefined;
	scheduledEvent(query: WorldScheduledEventQuery): ApiScheduledEvent | undefined;
	webhook(query: WorldWebhookQuery): ApiWebhook | undefined;
	guildTemplate(query: WorldGuildTemplateQuery): ApiGuildTemplate | undefined;
	soundboardSound(query: WorldSoundboardSoundQuery): ApiSoundboardSound | undefined;
	stageInstance(query: WorldStageInstanceQuery): ApiStageInstance | undefined;
	auditLogEntry(query: WorldAuditLogEntryQuery): ApiAuditLogEntry | undefined;
}

export interface WorldAllReader {
	guild(query?: WorldGuildFilter): GuildView[];
	channel(query?: WorldChannelFilter): ChannelView[];
	thread(query?: WorldThreadFilter): ChannelView[];
	dm(query?: WorldDmFilter): ChannelView[];
	member(query?: WorldMemberFilter): GuildMemberView[];
	role(query?: WorldRoleFilter): RoleView[];
	message(query?: WorldMessageFilter): MessageView[];
	rawMessage(query?: WorldMessageFilter): RawMessage[];
	voiceState(query?: WorldVoiceStateFilter): ApiVoiceState[];
	ban(query?: WorldBanFilter): BanSnapshot[];
	reaction(query?: WorldReactionFilter): ReactionView[];
	pin(query?: WorldPinFilter): MessageView[];
	pollVote(query?: WorldPollVoteFilter): PollVoterSnapshot[];
	threadMember(query?: WorldThreadMemberFilter): ThreadMemberSnapshot[];
	emoji(query?: WorldEmojiFilter): ApiEmoji[];
	invite(query?: WorldInviteFilter): ApiInvite[];
	autoModRule(query?: WorldAutoModRuleFilter): ApiAutoModRule[];
	sticker(query?: WorldStickerFilter): ApiSticker[];
	scheduledEvent(query?: WorldScheduledEventFilter): ApiScheduledEvent[];
	webhook(query?: WorldWebhookFilter): ApiWebhook[];
	guildTemplate(query?: WorldGuildTemplateFilter): ApiGuildTemplate[];
	soundboardSound(query?: WorldSoundboardSoundFilter): ApiSoundboardSound[];
	stageInstance(query?: WorldStageInstanceFilter): ApiStageInstance[];
	auditLogEntry(query?: WorldAuditLogEntryFilter): ApiAuditLogEntry[];
}

/**
 * The read-only view of {@link WorldState} exposed publicly as `bot.world`. Exposes only the query
 * methods test authors call to assert on world state; the internal mutators that the mock drives
 * in response to Discord traffic are intentionally absent so an internal refactor of them is not a
 * breaking change. The concrete {@link WorldState} class implements this and is used internally.
 */
export interface WorldStateReader {
	snapshot(): WorldSnapshot;
	diff(before: WorldSnapshot): WorldDiff;
	readonly get: WorldGetReader;
	readonly query: WorldQueryReader;
	readonly all: WorldAllReader;
}

export interface WorldCandidate<T> extends WorldStateCandidate {
	value: T;
}

export interface DerivedMentions {
	mention_everyone: boolean;
	mentions: ApiUser[];
	mention_roles: string[];
}
