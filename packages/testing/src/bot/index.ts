/*
 * Mock-bot maintenance map:
 * - New stateful route: add a Routes descriptor, a defaults responder, any needed
 *   WorldState mutator/view, a regression test, and a README line.
 * - New dispatcher verb: add the payload builder, MockBot method, Actor method,
 *   DISPATCHER_VERBS entry, matrix row, and README example.
 * - New world entity: add the payload factory, MockWorld field, WorldBuilder
 *   registration, cache seeding, state view, read/write responders, and a test
 *   that asserts both cache and view behavior.
 * - Seyfert deep imports are accepted break points for this peer range. If Seyfert
 *   reorganizes them, consolidate into one local internals module then.
 * - README export drift: repeat the README identifier cross-check on any
 *   README-touching mock-bot change.
 *
 * Public API surface: this barrel re-exports an explicit, curated allowlist - the
 * names a TEST AUTHOR legitimately uses. Internal helper modules (hooks,
 * option-validation, select-resolved, defaults, dispatch, dispatch-context),
 * world-events internals, rest.ts request plumbing, and the WorldState write
 * surface are deliberately NOT exported here. Deep imports remain available for
 * the package's own tests; do not promote internals into this list.
 */

export {
	type Actor,
	type ActorOptions,
	type AutocompleteResult,
	type BotDiagnostics,
	type CapturedReply,
	createMockBot,
	DISPATCHER_VERBS,
	type DispatchMessageOptions,
	type DispatchResult,
	type EventDispatchResult,
	type MenuCommandClass,
	type MenuOptions,
	type MenuResultFor,
	type MessageMenuResult,
	type MessageResultBase,
	MockBot,
	type MockBotOptions,
	type MockCommandClass,
	type MockEvent,
	type OptionsRecordOf,
	type OutgoingMessage,
	type PluginInfo,
	type RegisteredCommand,
	type RegisteredComponent,
	type SayResult,
	type SlashClassOptions,
	type SlashCommandClass,
	type SlashOptionsOf,
	type TargetFor,
	type UserMenuResult,
} from './bot';
export {
	TEST_APPLICATION_ID,
	TEST_BOT_ID,
	TEST_CHANNEL_ID,
	TEST_GUILD_ID,
	TEST_USER_ID,
} from './constants';
export { MockGateway, type MockGatewayOptions, type MockShard } from './gateway';
export {
	type ApiInteractionPayload,
	type AutocompleteInteractionOptions,
	attachmentOption,
	autocompleteInteraction,
	type BaseInteractionOptions,
	type ButtonInteractionOptions,
	buttonInteraction,
	type ChatInputInteractionOptions,
	channelOption,
	chatInputInteraction,
	DEFAULT_MEMBER_PERMISSIONS_STRING,
	DEFAULT_PERMISSIONS,
	type EncodedOption,
	type EntryPointInteractionOptions,
	entryPointInteraction,
	type MessageCommandInteractionOptions,
	type ModalSubmitInteractionOptions,
	mentionableOption,
	messageCommandInteraction,
	modalSubmitInteraction,
	type NamedOptionInput,
	type OptionInput,
	type OptionInputBag,
	rawOption,
	roleOption,
	type SelectMenuInteractionOptions,
	selectMenuInteraction,
	type UserCommandInteractionOptions,
	userCommandInteraction,
	userOption,
} from './interactions';
export {
	type ApiAttachment,
	type ApiAttachmentOptions,
	type ApiChannel,
	type ApiChannelOptions,
	type ApiGuild,
	type ApiGuildOptions,
	type ApiMember,
	type ApiMemberOptions,
	type ApiMessage,
	type ApiMessageOptions,
	type ApiRole,
	type ApiRoleOptions,
	type ApiThreadOptions,
	type ApiUser,
	type ApiUserOptions,
	type ApiVoiceState,
	type ApiVoiceStateOptions,
	apiAttachment,
	apiChannel,
	apiGuild,
	apiMember,
	apiMessage,
	apiRole,
	apiThread,
	apiUser,
	apiVoiceState,
	type MemberEventOptions,
	type MemberInput,
	type MemberUpdateEventOptions,
	memberAddEvent,
	memberOptionsFrom,
	memberRemoveEvent,
	memberUpdateEvent,
	type ThreadMetadata,
} from './payloads';
export {
	ALL_PERMISSIONS,
	type ChannelOverwriteLike,
	type ComputePermissionsInput,
	combineRolePermissions,
	computeChannelPermissions,
	DEFAULT_MEMBER_PERMISSIONS,
	type PermissionInput,
	permissionBits,
} from './permissions';
export {
	type ActionFilter,
	type ActionMatcher,
	type ActionPredicate,
	apiError,
	type DiscordErrorInit,
	DiscordErrors,
	type MatchedAction,
	MockApiError,
	type PendingAction,
	type RecordedAction,
	type RouteActionFilter,
	type RouteMatcher,
	type RouteResponder,
	type TypedMatchedAction,
	type ValuePredicate,
} from './rest';
export { Routes } from './routes';
export {
	type BanSnapshot,
	type ButtonView,
	type ChangedEntity,
	type ChannelSnapshot,
	type ChannelView,
	type EmbedView,
	type EntityDiff,
	type GuildMemberView,
	type GuildView,
	type MemberSnapshot,
	type MessageQuery,
	type MessageSnapshot,
	type MessageView,
	type ReactionView,
	type RoleSnapshot,
	type WorldDiff,
	type WorldSnapshot,
	type WorldStateReader,
} from './state';
export {
	type ChannelOverwriteInput,
	type MockWorld,
	mockWorld,
	WorldBuilder,
	type WorldChannelOptions,
	type WorldGuildOptions,
	type WorldRoleOptions,
	type WorldThreadOptions,
} from './world';
export { WORLD_EVENT_NAMES } from './world-events';
