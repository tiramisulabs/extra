import { ESLintUtils } from '@typescript-eslint/utils';
import noMethodDestructureFactory from '../src/rules/noMethodDestructure';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/no-method-destructure');
const rule = noMethodDestructureFactory(createRule);

// One representative per distinct Seyfert member declaration, including overloads.
// Inherited and re-exported copies share coverage; redeclarations stay separate.
// Keep a method diagnostic for each receiver with methods and the manual regressions.
createTester().run('no-method-destructure', rule, {
	valid: [
		// The idiomatic middleware arg: `context`/`next`/`stop` are properties (function-typed
		// fields), not methods — destructuring them is safe and must NOT be flagged.
		`import { createMiddleware } from 'seyfert';
export default createMiddleware<void>(({ context, next, stop }) => {
	if (!context.inGuild()) return stop('nope');
	next();
});`,
		// Getters / properties are safe to destructure (their value is read once).
		`import { type CommandContext } from 'seyfert';
function f(ctx: CommandContext) { const { author, client } = ctx; return { author, client }; }`,
		// A non-seyfert object's method is not our concern.
		`const obj = { editOrReply() {} };
const { editOrReply } = obj;
editOrReply();`,
		// A same-named method on a local class is not flagged.
		`class Fake { editOrReply() {} }
const { editOrReply } = new Fake();
editOrReply();`,
		"import { ActionRow } from 'seyfert';\ndeclare const value: InstanceType<typeof ActionRow>;\nconst { components: _v } = value;",
		"import { ActionRow } from 'seyfert';\ndeclare const value: InstanceType<typeof ActionRow>;\nconst { data: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { client: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { createdAt: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { createdTimestamp: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { id: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { partnered: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { shard: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { shardId: _v } = value;",
		"import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { verified: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { cdn: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { debug: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { debugger: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { globalBlock: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifyFailRequest: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifyRatelimit: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifyRequest: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifyRestObserverEntries: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifyRestObservers: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { notifySuccessRequest: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { onFailRequest: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { onRatelimit: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { onSuccessRequest: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { options: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { pluginRestObserverClient: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { pluginRestObserverProvider: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { proxy: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { ratelimits: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { readyQueue: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { restObservers: _v } = value;",
		"import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { workerPromises: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { appPermissions: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { channel: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { client: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { deferred: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { entitlements: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { matchReplied: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { member: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { message: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { replied: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { type: _v } = value;",
		"import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { user: _v } = value;",
		"import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { user: _v } = value;",
		"import { Attachment } from 'seyfert';\ndeclare const value: InstanceType<typeof Attachment>;\nconst { data: _v } = value;",
		"import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { data: _v } = value;",
		"import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { spoiler: _v } = value;",
		"import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { channel: _v } = value;",
		"import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { data: _v } = value;",
		"import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { entitlements: _v } = value;",
		"import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { options: _v } = value;",
		"import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { type: _v } = value;",
		"import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { type: _v } = value;",
		"import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { url: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { aliases: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { botPermissions: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { contexts: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { defaultMemberPermissions: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { description: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { description_localizations: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { guildId: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { ignore: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { integrationTypes: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { middlewares: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { name: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { name_localizations: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { nsfw: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { options: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { props: _v } = value;",
		"import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { type: _v } = value;",
		"import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { guildId: _v } = value;",
		"import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { invites: _v } = value;",
		"import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { permissionOverwrites: _v } = value;",
		"import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { url: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { communicationDisabledUntilTimestamp: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { guildId: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { hasTimeout: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { joinedTimestamp: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { patch: _v } = value;",
		"import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { roles: _v } = value;",
		"import { BaseInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseInteraction>;\nconst { channel: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { author: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { components: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { embeds: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { guildId: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { member: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { mentions: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { patch: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { poll: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { timestamp: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { url: _v } = value;",
		"import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { user: _v } = value;",
		"import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { adapter: _v } = value;",
		"import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { cache: _v } = value;",
		"import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { client: _v } = value;",
		"import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { namespace: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { channel: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { componentType: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { customId: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { data: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { entitlements: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { message: _v } = value;",
		"import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { type: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { adapter: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { bans: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { channels: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { emojis: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { guilds: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasChannelsIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasDirectMessages: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasGuildExpressionsIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasGuildMembersIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasGuildsIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasModerationIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasPresenceUpdates: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasRolesIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasVoiceStatesIntent: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { intents: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { members: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { messages: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { onPacketWithPluginResources: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { overwrites: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { pluginResourceNames: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { pluginResourcePacketErrorLogger: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { pluginResourcePacketHandlers: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { presences: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { roles: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { stageInstances: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { stickers: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { testChannelsAndOverwrites: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { testUsersAndMembers: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { users: _v } = value;",
		"import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { voiceStates: _v } = value;",
		"import { CategoryChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof CategoryChannel>;\nconst { type: _v } = value;",
		"import { ChannelSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { ChannelSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenuInteraction>;\nconst { channels: _v } = value;",
		"import { ChannelSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenuInteraction>;\nconst { data: _v } = value;",
		"import { ChannelSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenuInteraction>;\nconst { values: _v } = value;",
		"import { ChatInputCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChatInputCommandInteraction>;\nconst { channel: _v } = value;",
		"import { ChatInputCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChatInputCommandInteraction>;\nconst { data: _v } = value;",
		"import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { data: _v } = value;",
		"import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { application: _v } = value;",
		"import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { bot: _v } = value;",
		"import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { name: _v } = value;",
		"import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { tag: _v } = value;",
		"import { Collectors } from 'seyfert';\ndeclare const value: InstanceType<typeof Collectors>;\nconst { delete: _v } = value;",
		"import { Collectors } from 'seyfert';\ndeclare const value: InstanceType<typeof Collectors>;\nconst { generateRandomUUID: _v } = value;",
		"import { Collectors } from 'seyfert';\ndeclare const value: InstanceType<typeof Collectors>;\nconst { values: _v } = value;",
		"import { Command } from 'seyfert';\ndeclare const value: InstanceType<typeof Command>;\nconst { groups: _v } = value;",
		"import { Command } from 'seyfert';\ndeclare const value: InstanceType<typeof Command>;\nconst { groupsAliases: _v } = value;",
		"import { Command } from 'seyfert';\ndeclare const value: InstanceType<typeof Command>;\nconst { type: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { author: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { channelId: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { client: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { command: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { deferred: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { fullCommandName: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { globalMetadata: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { guildId: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { interaction: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { member: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { message: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { messageResponse: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { metadata: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { options: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { proxy: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { resolver: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { shardId: _v } = value;",
		"import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { t: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { componentType: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { cType: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { customId: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { middlewares: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { props: _v } = value;",
		"import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { type: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { author: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { channelId: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { client: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { command: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { customId: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { globalMetadata: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { guildId: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { interaction: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { member: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { message: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { metadata: _v } = value;",
		"import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { t: _v } = value;",
		"import { ComponentInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentInteraction>;\nconst { data: _v } = value;",
		"import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { components: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { botPermissions: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { contexts: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { defaultMemberPermissions: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { description: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { description_localizations: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { dm: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { guildId: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { integrationTypes: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { middlewares: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { name: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { name_localizations: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { nsfw: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { props: _v } = value;",
		"import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { type: _v } = value;",
		"import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { client: _v } = value;",
		"import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { filter: _v } = value;",
		"import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { logger: _v } = value;",
		"import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { onFail: _v } = value;",
		"import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { values: _v } = value;",
		"import { DirectoryChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DirectoryChannel>;\nconst { guildId: _v } = value;",
		"import { DMChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DMChannel>;\nconst { messages: _v } = value;",
		"import { DMChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DMChannel>;\nconst { pins: _v } = value;",
		"import { DMChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DMChannel>;\nconst { reactions: _v } = value;",
		"import { DMChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DMChannel>;\nconst { type: _v } = value;",
		"import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { data: _v } = value;",
		"import { Entitlement } from 'seyfert';\ndeclare const value: InstanceType<typeof Entitlement>;\nconst { endsAtTimestamp: _v } = value;",
		"import { Entitlement } from 'seyfert';\ndeclare const value: InstanceType<typeof Entitlement>;\nconst { startsAtTimestamp: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { botPermissions: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { contexts: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { description: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { description_localizations: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { dm: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { handler: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { integrationTypes: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { middlewares: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { name: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { name_localizations: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { nsfw: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { props: _v } = value;",
		"import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { type: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { author: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { channelId: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { client: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { command: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { deferred: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { fullCommandName: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { globalMetadata: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { guildId: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { interaction: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { member: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { metadata: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { shardId: _v } = value;",
		"import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { t: _v } = value;",
		"import { EntryPointInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointInteraction>;\nconst { channel: _v } = value;",
		"import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { callback: _v } = value;",
		"import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { client: _v } = value;",
		"import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { discordEvents: _v } = value;",
		"import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { filter: _v } = value;",
		"import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { type: _v } = value;",
		"import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { webhooks: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { bans: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { channels: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { emojis: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { invites: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { joinedAt: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { large: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { maxEmojis: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { maxStickers: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { memberCount: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { members: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { moderationRules: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { roles: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { stickers: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { templates: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { unavailable: _v } = value;",
		"import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { webhooks: _v } = value;",
		"import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { guildId: _v } = value;",
		"import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { adapter: _v } = value;",
		"import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { cache: _v } = value;",
		"import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { client: _v } = value;",
		"import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { namespace: _v } = value;",
		"import { GuildEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildEmoji>;\nconst { guildId: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { bot: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { displayName: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { globalName: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { guildId: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { name: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { tag: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { user: _v } = value;",
		"import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { username: _v } = value;",
		"import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { adapter: _v } = value;",
		"import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { cache: _v } = value;",
		"import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { client: _v } = value;",
		"import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { namespace: _v } = value;",
		"import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { guildId: _v } = value;",
		"import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { permissions: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { applicationId: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { applications: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { applyPluginCommands: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { applyPluginComponents: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { applyPluginLangs: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { bans: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { bindPluginLangReload: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { bindPluginRestObserverProvider: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { botId: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { cache: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { cachedCommandGuilds: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { channels: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { commands: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { components: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { createPluginCommandInstance: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { createPluginComponentInstance: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { createPluginLoadedMetadata: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { debugger: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { emitPluginCustomEvent: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { emitUploadCommandsMetadata: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { emojis: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { events: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { guilds: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { handleCommand: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { interactions: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { invites: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { langBaseValues: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { langs: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { loadedCommands: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { logger: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { matchesPluginHandlerKind: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { members: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { messages: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { middlewares: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { options: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { pluginBaseGatewayIntents: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { pluginCacheDisabledCache: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { pluginComponentsBeforeLoadDepth: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { plugins: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { pluginsClosePromise: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { pluginsSetupPromise: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { proxy: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { reactions: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { refreshPluginCacheResources: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { reloadPluginCommands: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { reloadPluginComponents: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { reloadPluginMiddlewares: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { rest: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { roles: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { runPluginHandlerCreators: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { setupPlugins: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { shared: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { shouldUploadCommands: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { soundboards: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { syncCachePath: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { templates: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { threads: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { users: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { voiceStates: _v } = value;",
		"import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { webhooks: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { author: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { color: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { data: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { description: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { fields: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { footer: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { image: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { provider: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { thumbnail: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { timestamp: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { title: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { type: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { url: _v } = value;",
		"import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { video: _v } = value;",
		"import { Interaction } from 'seyfert';\ndeclare const value: InstanceType<typeof Interaction>;\nconst { channel: _v } = value;",
		"import { InteractionGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionGuildMember>;\nconst { permissions: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { author: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { channelId: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { client: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { customId: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { globalMetadata: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { guildId: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { interaction: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { member: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { metadata: _v } = value;",
		"import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { t: _v } = value;",
		"import { Label } from 'seyfert';\ndeclare const value: InstanceType<typeof Label>;\nconst { component: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { aliases: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { applyParsedFile: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { defaultLang: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { filter: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { onReload: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { preferGuildLocale: _v } = value;",
		"import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { values: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { clearExpired: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { closer: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { data: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { expirations: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { options: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { resetTimeout: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { size: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { startTimeout: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { stopTimeout: _v } = value;",
		"import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { timeout: _v } = value;",
		"import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { isAsync: _v } = value;",
		"import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { keyToStorage: _v } = value;",
		"import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { options: _v } = value;",
		"import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { relationships: _v } = value;",
		"import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { storage: _v } = value;",
		"import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { active: _v } = value;",
		"import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { level: _v } = value;",
		"import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { name: _v } = value;",
		"import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { options: _v } = value;",
		"import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { saveOnFile: _v } = value;",
		"import { MediaChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaChannel>;\nconst { type: _v } = value;",
		"import { MediaGallery } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGallery>;\nconst { items: _v } = value;",
		"import { MediaGalleryItem } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGalleryItem>;\nconst { data: _v } = value;",
		"import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { isAsync: _v } = value;",
		"import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { options: _v } = value;",
		"import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { relationships: _v } = value;",
		"import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { storage: _v } = value;",
		"import { MentionableSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { MentionableSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenuInteraction>;\nconst { members: _v } = value;",
		"import { MentionableSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenuInteraction>;\nconst { roles: _v } = value;",
		"import { MentionableSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenuInteraction>;\nconst { users: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { author: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { channelId: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { client: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { command: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { deferred: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { fullCommandName: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { globalMetadata: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { guildId: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { interaction: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { member: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { metadata: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { shardId: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { t: _v } = value;",
		"import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { target: _v } = value;",
		"import { MessageCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MessageCommandInteraction>;\nconst { channel: _v } = value;",
		"import { MessageCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MessageCommandInteraction>;\nconst { data: _v } = value;",
		"import { MessageCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MessageCommandInteraction>;\nconst { type: _v } = value;",
		"import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { components: _v } = value;",
		"import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { data: _v } = value;",
		"import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { customId: _v } = value;",
		"import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { middlewares: _v } = value;",
		"import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { props: _v } = value;",
		"import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { type: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { author: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { channelId: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { client: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { command: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { components: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { customId: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { globalMetadata: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { guildId: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { interaction: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { member: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { metadata: _v } = value;",
		"import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { t: _v } = value;",
		"import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { channel: _v } = value;",
		"import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { components: _v } = value;",
		"import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { customId: _v } = value;",
		"import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { data: _v } = value;",
		"import { NewsChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof NewsChannel>;\nconst { type: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { client: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { fullCommandName: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getTypedOption: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { group: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { guildId: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { hoistedOptions: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { options: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { parent: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { resolved: _v } = value;",
		"import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { subCommand: _v } = value;",
		"import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { channelId: _v } = value;",
		"import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { expiryAt: _v } = value;",
		"import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { expiryTimestamp: _v } = value;",
		"import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { messageId: _v } = value;",
		"import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { data: _v } = value;",
		"import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { resolvedPollMedia: _v } = value;",
		"import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { data: _v } = value;",
		"import { RoleSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof RoleSelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { RoleSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof RoleSelectMenuInteraction>;\nconst { roles: _v } = value;",
		"import { Router } from 'seyfert';\ndeclare const value: InstanceType<typeof Router>;\nconst { noop: _v } = value;",
		"import { Router } from 'seyfert';\ndeclare const value: InstanceType<typeof Router>;\nconst { rest: _v } = value;",
		"import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { accessory: _v } = value;",
		"import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { components: _v } = value;",
		"import { SelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof SelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { SeyfertError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertError>;\nconst { code: _v } = value;",
		"import { SeyfertError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertError>;\nconst { metadata: _v } = value;",
		"import { SeyfertError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertError>;\nconst { name: _v } = value;",
		"import { SeyfertPluginAggregateError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginAggregateError>;\nconst { cause: _v } = value;",
		"import { SeyfertPluginAggregateError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginAggregateError>;\nconst { errors: _v } = value;",
		"import { SeyfertPluginAggregateError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginAggregateError>;\nconst { name: _v } = value;",
		"import { SeyfertPluginError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginError>;\nconst { index: _v } = value;",
		"import { SeyfertPluginError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginError>;\nconst { instanceId: _v } = value;",
		"import { SeyfertPluginError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginError>;\nconst { phase: _v } = value;",
		"import { SeyfertPluginError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginError>;\nconst { plugin: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { concurrency: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { connectQueue: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { debugger: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { latency: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { options: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { remaining: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { resolveSendPayload: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { shardEnd: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { shardStart: _v } = value;",
		"import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { totalShards: _v } = value;",
		"import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { guildId: _v } = value;",
		"import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { type: _v } = value;",
		"import { Sticker } from 'seyfert';\ndeclare const value: InstanceType<typeof Sticker>;\nconst { user: _v } = value;",
		"import { StringSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenu>;\nconst { data: _v } = value;",
		"import { StringSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { StringSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenuInteraction>;\nconst { data: _v } = value;",
		"import { StringSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenuInteraction>;\nconst { values: _v } = value;",
		"import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { data: _v } = value;",
		"import { SubCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof SubCommand>;\nconst { group: _v } = value;",
		"import { SubCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof SubCommand>;\nconst { options: _v } = value;",
		"import { SubCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof SubCommand>;\nconst { type: _v } = value;",
		"import { TextGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof TextGuildChannel>;\nconst { type: _v } = value;",
		"import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { parentId: _v } = value;",
		"import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { type: _v } = value;",
		"import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { webhooks: _v } = value;",
		"import { UnavailableMember } from 'seyfert';\ndeclare const value: InstanceType<typeof UnavailableMember>;\nconst { pending: _v } = value;",
		"import { UserCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserCommandInteraction>;\nconst { channel: _v } = value;",
		"import { UserCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserCommandInteraction>;\nconst { data: _v } = value;",
		"import { UserCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserCommandInteraction>;\nconst { type: _v } = value;",
		"import { UserSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenuInteraction>;\nconst { channel: _v } = value;",
		"import { UserSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenuInteraction>;\nconst { members: _v } = value;",
		"import { UserSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenuInteraction>;\nconst { users: _v } = value;",
		"import { VoiceChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceChannel>;\nconst { guildId: _v } = value;",
		"import { VoiceChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceChannel>;\nconst { type: _v } = value;",
		"import { VoiceChannelMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceChannelMethods>;\nconst { guildId: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { isCameraOn: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { isDeafened: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { isMuted: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { isStreaming: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { isSuppressed: _v } = value;",
		"import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { withMember: _v } = value;",
		"import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { messages: _v } = value;",
		"import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { sourceGuild: _v } = value;",
		"import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { user: _v } = value;",
		"import { WebhookChannelMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookChannelMethods>;\nconst { webhooks: _v } = value;",
		"import { WebhookGuildMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookGuildMethods>;\nconst { webhooks: _v } = value;",
		"import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { webhookId: _v } = value;",
		"import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { webhookToken: _v } = value;",
		"import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { isAsync: _v } = value;",
		"import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { promises: _v } = value;",
		"import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { workerData: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { applicationId: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { collectors: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { events: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { generateNonce: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { generateSendPromise: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { latency: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { me: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { memberUpdateHandler: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { onShardDisconnect: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { onShardReconnect: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { options: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { presenceUpdateHandler: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { promises: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { resharding: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { shards: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { workerData: _v } = value;",
		"import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { workerId: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { cacheAdapter: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { concurrency: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { connectQueue: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { debugger: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { generateNonce: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { generateSendPromise: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { heartbeater: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { options: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { promises: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { remaining: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { reshardingWorkerQueue: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { resolveSendPayload: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { rest: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { shardEnd: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { shardsPerWorker: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { shardStart: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { totalShards: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { totalWorkers: _v } = value;",
		"import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { workerQueue: _v } = value;",
	],
	invalid: [
		// Renamed destructure still detaches the method.
		{
			code: `import { type CommandContext } from 'seyfert';
function f(ctx: CommandContext) { const { editOrReply: reply } = ctx; reply({ content: 'x' }); }`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		// Destructuring in a function parameter position (non-VariableDeclarator source).
		{
			code: `import { type CommandContext } from 'seyfert';
function f({ editOrReply }: CommandContext) { editOrReply({ content: 'x' }); }`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		// The reported real-world crash: destructuring a context method inside a middleware.
		{
			code: `import { createMiddleware } from 'seyfert';
export default createMiddleware<void>((middle) => {
	const { editOrReply } = middle.context;
	editOrReply({ content: 'x' });
});`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { ActionRow } from 'seyfert';\ndeclare const value: InstanceType<typeof ActionRow>;\nconst { addComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addComponents' } }],
		},
		{
			code: "import { ActionRow } from 'seyfert';\ndeclare const value: InstanceType<typeof ActionRow>;\nconst { setComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setComponents' } }],
		},
		{
			code: "import { ActionRow } from 'seyfert';\ndeclare const value: InstanceType<typeof ActionRow>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { bannerURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bannerURL' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { iconURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'iconURL' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { leave: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'leave' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { splashURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'splashURL' } }],
		},
		{
			code: "import { AnonymousGuild } from 'seyfert';\ndeclare const value: InstanceType<typeof AnonymousGuild>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { clearResetInterval: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'clearResetInterval' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { globalUnblock: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'globalUnblock' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { handle429: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'handle429' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { handle50X: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'handle50X' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { observe: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'observe' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { parseError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parseError' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { parseRequest: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parseRequest' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { parseValidationError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parseValidationError' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { postMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'postMessage' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { randomUUID: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'randomUUID' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { request: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'request' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { routefy: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'routefy' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { sendMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'sendMessage' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { setRatelimitsBucket: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRatelimitsBucket' } }],
		},
		{
			code: "import { ApiHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof ApiHandler>;\nconst { setResetBucket: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setResetBucket' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { deleteMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteMessage' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { editMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editMessage' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { fetchGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchGuild' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { fetchMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchMessage' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { hasRepliedOrAwaitPendingReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hasRepliedOrAwaitPendingReply' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isAutocomplete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isAutocomplete' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isButton: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isButton' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isChannelSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isChatInput: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChatInput' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isEntryPoint: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isMentionableSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMessage' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isModal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isModal' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isRoleSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isStringSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUser' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { isUserSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { reply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reply' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { respond: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'respond' } }],
		},
		{
			code: "import { ApplicationCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationCommandInteraction>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { ApplicationEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof ApplicationEmoji>;\nconst { url: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'url' } }],
		},
		{
			code: "import { Attachment } from 'seyfert';\ndeclare const value: InstanceType<typeof Attachment>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { setFile: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setFile' } }],
		},
		{
			code: "import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { setName: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setName' } }],
		},
		{
			code: "import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { setSpoiler: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } }],
		},
		{
			code: "import { AttachmentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof AttachmentBuilder>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { getInput: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getInput' } }],
		},
		{
			code: "import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { isAutocomplete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isAutocomplete' } }],
		},
		{
			code: "import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { reply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reply' } }],
		},
		{
			code: "import { AutocompleteInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof AutocompleteInteraction>;\nconst { respond: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'respond' } }],
		},
		{
			code: "import { AutoModerationRule } from 'seyfert';\ndeclare const value: InstanceType<typeof AutoModerationRule>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { AutoModerationRule } from 'seyfert';\ndeclare const value: InstanceType<typeof AutoModerationRule>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { AutoModerationRule } from 'seyfert';\ndeclare const value: InstanceType<typeof AutoModerationRule>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { AutoModerationRule } from 'seyfert';\ndeclare const value: InstanceType<typeof AutoModerationRule>;\nconst { fetchCreator: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchCreator' } }],
		},
		{
			code: "import { AutoModerationRule } from 'seyfert';\ndeclare const value: InstanceType<typeof AutoModerationRule>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { is: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'is' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isCategory: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isCategory' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isDirectory: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isDirectory' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isDM: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isDM' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isForum: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isForum' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isGuild' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isGuildTextable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isGuildTextable' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isMedia: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMedia' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isNamed: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isNamed' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isNews: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isNews' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isStage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStage' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isTextable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isTextable' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isTextGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isTextGuild' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isThread: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isThread' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isThreadOnly: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isThreadOnly' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { isVoice: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isVoice' } }],
		},
		{
			code: "import { BaseChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseChannel>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onAfterRun: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onBeforeMiddlewares: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onBeforeOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeOptions' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onBotPermissionsFail: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onInternalError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInternalError' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onMiddlewaresError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onOptionsError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onOptionsError' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onPermissionsFail: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onPermissionsFail' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { onRunError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onRunError' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { reload: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reload' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { BaseCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseCommand>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { BaseComponentBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseComponentBuilder>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { memberPermissions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'memberPermissions' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { overwritesFor: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'overwritesFor' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { rolePermissions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'rolePermissions' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { setName: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setName' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { setNsfw: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setNsfw' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { setParent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setParent' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { setPosition: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setPosition' } }],
		},
		{
			code: "import { BaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildChannel>;\nconst { setRatelimitPerUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRatelimitPerUser' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { ban: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'ban' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { kick: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'kick' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { presence: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'presence' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { timeout: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'timeout' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { BaseGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseGuildMember>;\nconst { voice: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'voice' } }],
		},
		{
			code: "import { BaseInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseInteraction>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { createComponentCollector: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'createComponentCollector' } }],
		},
		{
			code: "import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { BaseMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseMessage>;\nconst { react: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'react' } }],
		},
		{
			code: "import { BaseNoEditableChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseNoEditableChannel>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { bulk: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulk' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { hashId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hashId' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { removeIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { setIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setIfNI' } }],
		},
		{
			code: "import { BaseResource } from 'seyfert';\ndeclare const value: InstanceType<typeof BaseResource>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setDisabled: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDisabled' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setEmoji: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setEmoji' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setLabel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLabel' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setSKUId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSKUId' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setStyle: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setStyle' } }],
		},
		{
			code: "import { Button } from 'seyfert';\ndeclare const value: InstanceType<typeof Button>;\nconst { setURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setURL' } }],
		},
		{
			code: "import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { deferUpdate: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } }],
		},
		{
			code: "import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { isButton: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isButton' } }],
		},
		{
			code: "import { ButtonInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ButtonInteraction>;\nconst { update: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'update' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { buildCache: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'buildCache' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { bulkGet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkGet' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { bulkPatch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { bulkSet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkSet' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { hasIntent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hasIntent' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { onPacket: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onPacket' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { onPacketDefault: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onPacketDefault' } }],
		},
		{
			code: "import { Cache } from 'seyfert';\ndeclare const value: InstanceType<typeof Cache>;\nconst { testAdapter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'testAdapter' } }],
		},
		{
			code: "import { CategoryChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof CategoryChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { addDefaultChannels: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addDefaultChannels' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setChannelTypes: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setChannelTypes' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setDefaultChannels: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefaultChannels' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setDisabled: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDisabled' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setPlaceholder: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setPlaceholder' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { ChannelSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenu>;\nconst { setValuesLength: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setValuesLength' } }],
		},
		{
			code: "import { ChannelSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChannelSelectMenuInteraction>;\nconst { isChannelSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } }],
		},
		{
			code: "import { ChatInputCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ChatInputCommandInteraction>;\nconst { isChatInput: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChatInput' } }],
		},
		{
			code: "import { Checkbox } from 'seyfert';\ndeclare const value: InstanceType<typeof Checkbox>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { Checkbox } from 'seyfert';\ndeclare const value: InstanceType<typeof Checkbox>;\nconst { setDefault: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefault' } }],
		},
		{
			code: "import { Checkbox } from 'seyfert';\ndeclare const value: InstanceType<typeof Checkbox>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { addOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addOptions' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { setOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setOptions' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { setSelectionLimit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSelectionLimit' } }],
		},
		{
			code: "import { CheckboxGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroup>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { setDefault: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefault' } }],
		},
		{
			code: "import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { setLabel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLabel' } }],
		},
		{
			code: "import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { setValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setValue' } }],
		},
		{
			code: "import { CheckboxGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof CheckboxGroupOption>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { avatarDecorationURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarDecorationURL' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { avatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarURL' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { bannerURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bannerURL' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { defaultAvatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'defaultAvatarURL' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { dm: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'dm' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { presence: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'presence' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { ClientUser } from 'seyfert';\ndeclare const value: InstanceType<typeof ClientUser>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { every: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'every' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { filterCollection: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filterCollection' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { find: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'find' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { findKey: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'findKey' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { map: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'map' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { reduce: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reduce' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { some: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'some' } }],
		},
		{
			code: "import { Collection } from 'seyfert';\ndeclare const value: InstanceType<typeof Collection>;\nconst { sweep: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'sweep' } }],
		},
		{
			code: "import { Collectors } from 'seyfert';\ndeclare const value: InstanceType<typeof Collectors>;\nconst { create: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'create' } }],
		},
		{
			code: "import { Command } from 'seyfert';\ndeclare const value: InstanceType<typeof Command>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { fetchMember: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchMember' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isButton: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isButton' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isChannelSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isChat: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChat' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isComponent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isComponent' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isEntryPoint: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isMentionableSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isMenuMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenuMessage' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isMenuUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenuUser' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isModal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isModal' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isRoleSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isStringSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { isUserSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { CommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof CommandContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { onAfterRun: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { onBeforeMiddlewares: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { onInternalError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInternalError' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { onMiddlewaresError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { onRunError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onRunError' } }],
		},
		{
			code: "import { ComponentCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { deferUpdate: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isButton: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isButton' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isChannelSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isChat: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChat' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isComponent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isComponent' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isMentionableSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isRoleSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isStringSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { isUserSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { update: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'update' } }],
		},
		{
			code: "import { ComponentContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { ComponentInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ComponentInteraction>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { addComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addComponents' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { setColor: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setColor' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { setComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setComponents' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { setSpoiler: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } }],
		},
		{
			code: "import { Container } from 'seyfert';\ndeclare const value: InstanceType<typeof Container>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onAfterRun: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onBeforeMiddlewares: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onBotPermissionsFail: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onInternalError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInternalError' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onMiddlewaresError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { onRunError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onRunError' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { reload: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reload' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { ContextMenuCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ContextMenuCommand>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { createPluginListenerTask: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'createPluginListenerTask' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { emit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'emit' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { getFiles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getFiles' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { getPluginAnyListeners: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getPluginAnyListeners' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { getPluginErrorListeners: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getPluginErrorListeners' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { getPluginListeners: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getPluginListeners' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { loadFiles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadFiles' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { loadFilesK: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadFilesK' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { reportEventFailure: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reportEventFailure' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { runCollectors: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'runCollectors' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { runCustom: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'runCustom' } }],
		},
		{
			code: "import { CustomEventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof CustomEventHandler>;\nconst { settleEventTasks: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'settleEventTasks' } }],
		},
		{
			code: "import { DirectoryChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DirectoryChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { DMChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof DMChannel>;\nconst { typing: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { addFields: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addFields' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setAuthor: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setAuthor' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setColor: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setColor' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setFields: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setFields' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setFooter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setFooter' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setImage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setImage' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setThumbnail: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setThumbnail' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setTimestamp: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTimestamp' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setTitle: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTitle' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { setURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setURL' } }],
		},
		{
			code: "import { Embed } from 'seyfert';\ndeclare const value: InstanceType<typeof Embed>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { Emoji } from 'seyfert';\ndeclare const value: InstanceType<typeof Emoji>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { Entitlement } from 'seyfert';\ndeclare const value: InstanceType<typeof Entitlement>;\nconst { consume: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'consume' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onAfterRun: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onBeforeMiddlewares: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onBotPermissionsFail: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onInternalError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInternalError' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onMiddlewaresError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { onRunError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onRunError' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { reload: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reload' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { EntryPointCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointCommand>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { isEntryPoint: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { EntryPointContext } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { EntryPointInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointInteraction>;\nconst { isEntryPoint: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } }],
		},
		{
			code: "import { EntryPointInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof EntryPointInteraction>;\nconst { withResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'withResponse' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { execute: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'execute' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { load: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'load' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { onFile: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onFile' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { reload: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reload' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { reloadAll: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reloadAll' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { runEvent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'runEvent' } }],
		},
		{
			code: "import { EventHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof EventHandler>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { File } from 'seyfert';\ndeclare const value: InstanceType<typeof File>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { File } from 'seyfert';\ndeclare const value: InstanceType<typeof File>;\nconst { setMedia: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMedia' } }],
		},
		{
			code: "import { File } from 'seyfert';\ndeclare const value: InstanceType<typeof File>;\nconst { setSpoiler: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } }],
		},
		{
			code: "import { FileUpload } from 'seyfert';\ndeclare const value: InstanceType<typeof FileUpload>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { FileUpload } from 'seyfert';\ndeclare const value: InstanceType<typeof FileUpload>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { FileUpload } from 'seyfert';\ndeclare const value: InstanceType<typeof FileUpload>;\nconst { setMaxValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMaxValues' } }],
		},
		{
			code: "import { FileUpload } from 'seyfert';\ndeclare const value: InstanceType<typeof FileUpload>;\nconst { setMinValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMinValues' } }],
		},
		{
			code: "import { FileUpload } from 'seyfert';\ndeclare const value: InstanceType<typeof FileUpload>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setAutoArchiveDuration: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setAutoArchiveDuration' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setReactionEmoji: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setReactionEmoji' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setSortOrder: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSortOrder' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setTags: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTags' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setThreadRateLimit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setThreadRateLimit' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { setTopic: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTopic' } }],
		},
		{
			code: "import { ForumChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ForumChannel>;\nconst { thread: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'thread' } }],
		},
		{
			code: "import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { fetchOwner: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchOwner' } }],
		},
		{
			code: "import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { listActiveThreads: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'listActiveThreads' } }],
		},
		{
			code: "import { Guild } from 'seyfert';\ndeclare const value: InstanceType<typeof Guild>;\nconst { searchMessages: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'searchMessages' } }],
		},
		{
			code: "import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { create: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'create' } }],
		},
		{
			code: "import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { GuildBan } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBan>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { bulk: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulk' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { hashGuildId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hashGuildId' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { hashId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hashId' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { parse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parse' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { removeIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { removeRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { setIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setIfNI' } }],
		},
		{
			code: "import { GuildBasedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildBasedResource>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { GuildEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildEmoji>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { GuildEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildEmoji>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { GuildEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildEmoji>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { GuildEmoji } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildEmoji>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { avatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarURL' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { bannable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bannable' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { bannerURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bannerURL' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { defaultAvatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'defaultAvatarURL' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { dm: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'dm' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { fetchPermissions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchPermissions' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { kickable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'kickable' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { manageable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'manageable' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { moderatable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'moderatable' } }],
		},
		{
			code: "import { GuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildMember>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { GuildPreview } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildPreview>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { bulk: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulk' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { hashId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'hashId' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { parse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parse' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { removeIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { removeRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { setIfNI: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setIfNI' } }],
		},
		{
			code: "import { GuildRelatedResource } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRelatedResource>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { GuildRole } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildRole>;\nconst { toString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toString' } }],
		},
		{
			code: "import { GuildTemplate } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildTemplate>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { GuildTemplate } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildTemplate>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { GuildTemplate } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildTemplate>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { GuildTemplate } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildTemplate>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { GuildTemplate } from 'seyfert';\ndeclare const value: InstanceType<typeof GuildTemplate>;\nconst { sync: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'sync' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { close: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'close' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { configureLogger: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'configureLogger' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { execute: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'execute' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { getRC: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getRC' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { loadCommands: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadCommands' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { loadComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadComponents' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { loadLangs: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadLangs' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { onInteractionRequest: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInteractionRequest' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { onPacket: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onPacket' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { reloadPluginContributions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reloadPluginContributions' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { resolvePluginGatewayIntents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'resolvePluginGatewayIntents' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { setServices: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setServices' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { t: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 't' } }],
		},
		{
			code: "import { HttpClient } from 'seyfert';\ndeclare const value: InstanceType<typeof HttpClient>;\nconst { uploadCommands: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'uploadCommands' } }],
		},
		{
			code: "import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { toBuilder: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toBuilder' } }],
		},
		{
			code: "import { InMessageEmbed } from 'seyfert';\ndeclare const value: InstanceType<typeof InMessageEmbed>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { Interaction } from 'seyfert';\ndeclare const value: InstanceType<typeof Interaction>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { InteractionGuildMember } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionGuildMember>;\nconst { avatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarURL' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { InteractionResponseContext } from 'seyfert';\ndeclare const value: InstanceType<typeof InteractionResponseContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { Label } from 'seyfert';\ndeclare const value: InstanceType<typeof Label>;\nconst { setComponent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setComponent' } }],
		},
		{
			code: "import { Label } from 'seyfert';\ndeclare const value: InstanceType<typeof Label>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { Label } from 'seyfert';\ndeclare const value: InstanceType<typeof Label>;\nconst { setLabel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLabel' } }],
		},
		{
			code: "import { Label } from 'seyfert';\ndeclare const value: InstanceType<typeof Label>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { getKey: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getKey' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { getLocale: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getLocale' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { load: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'load' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { onFile: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onFile' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { parse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'parse' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { reload: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reload' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { reloadAll: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reloadAll' } }],
		},
		{
			code: "import { LangsHandler } from 'seyfert';\ndeclare const value: InstanceType<typeof LangsHandler>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { clear: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'clear' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { entries: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'entries' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { has: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'has' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { raw: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'raw' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { rawEntries: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'rawEntries' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { rawValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'rawValues' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { LimitedCollection } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedCollection>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { bulkAddToRelationShip: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { bulkGet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkGet' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { bulkPatch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { bulkRemove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { bulkSet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkSet' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { removeRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { scan: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'scan' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { LimitedMemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof LimitedMemoryAdapter>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { debug: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'debug' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { error: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'error' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { fatal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fatal' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { info: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'info' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { rawLog: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'rawLog' } }],
		},
		{
			code: "import { Logger } from 'seyfert';\ndeclare const value: InstanceType<typeof Logger>;\nconst { warn: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'warn' } }],
		},
		{
			code: "import { MediaChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { MediaGallery } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGallery>;\nconst { addItems: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addItems' } }],
		},
		{
			code: "import { MediaGallery } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGallery>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { MediaGallery } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGallery>;\nconst { setItems: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setItems' } }],
		},
		{
			code: "import { MediaGallery } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGallery>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { MediaGalleryItem } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGalleryItem>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { MediaGalleryItem } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGalleryItem>;\nconst { setMedia: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMedia' } }],
		},
		{
			code: "import { MediaGalleryItem } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGalleryItem>;\nconst { setSpoiler: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } }],
		},
		{
			code: "import { MediaGalleryItem } from 'seyfert';\ndeclare const value: InstanceType<typeof MediaGalleryItem>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { bulkAddToRelationShip: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { bulkGet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkGet' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { bulkPatch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { bulkRemove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { bulkSet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkSet' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { removeRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { scan: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'scan' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { MemoryAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof MemoryAdapter>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { MentionableSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenu>;\nconst { addDefaultMentionables: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addDefaultMentionables' } }],
		},
		{
			code: "import { MentionableSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenu>;\nconst { setDefaultMentionables: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefaultMentionables' } }],
		},
		{
			code: "import { MentionableSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MentionableSelectMenuInteraction>;\nconst { isMentionableSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { isMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenu' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { isMenuMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenuMessage' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { isMenuUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMenuUser' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { MenuCommandContext } from 'seyfert';\ndeclare const value: InstanceType<typeof MenuCommandContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { crosspost: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'crosspost' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { endPoll: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'endPoll' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { getAnswerVoters: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getAnswerVoters' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { reply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'reply' } }],
		},
		{
			code: "import { Message } from 'seyfert';\ndeclare const value: InstanceType<typeof Message>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { MessageCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof MessageCommandInteraction>;\nconst { isMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMessage' } }],
		},
		{
			code: "import { MessagesMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof MessagesMethods>;\nconst { typing: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { addComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addComponents' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { setComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setComponents' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { setTitle: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTitle' } }],
		},
		{
			code: "import { Modal } from 'seyfert';\ndeclare const value: InstanceType<typeof Modal>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { filter: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'filter' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { onAfterRun: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { onBeforeMiddlewares: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { onInternalError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onInternalError' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { onMiddlewaresError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { onRunError: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onRunError' } }],
		},
		{
			code: "import { ModalCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { deferUpdate: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { deleteResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { editOrReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editOrReply' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { editResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'editResponse' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { fetchResponse: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { followup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'followup' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getChannels: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getChannels' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getCheckbox: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getCheckbox' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getCheckboxValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getCheckboxValues' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getFiles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getFiles' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getInputValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getInputValue' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getMentionables: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getMentionables' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getRadioValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getRadioValues' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getRoles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getRoles' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { getUsers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getUsers' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { inGuild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'inGuild' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { isModal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isModal' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { me: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'me' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { modal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'modal' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { update: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'update' } }],
		},
		{
			code: "import { ModalContext } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalContext>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { deferUpdate: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getChannels: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getChannels' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getCheckbox: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getCheckbox' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getCheckboxValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getCheckboxValues' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getComponent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getComponent' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getFiles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getFiles' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getInputValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getInputValue' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getMentionables: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getMentionables' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getRadioValues: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getRadioValues' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getRoles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getRoles' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { getUsers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getUsers' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { isModal: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isModal' } }],
		},
		{
			code: "import { ModalSubmitInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof ModalSubmitInteraction>;\nconst { update: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'update' } }],
		},
		{
			code: "import { NewsChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof NewsChannel>;\nconst { addFollower: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addFollower' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getAutocomplete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getAutocomplete' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getAutocompleteValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getAutocompleteValue' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getChannel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getChannel' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getCommand: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getCommand' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getGroup: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getGroup' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getHoisted: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getHoisted' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getParent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getParent' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getString: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getString' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getSubCommand: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getSubCommand' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { getValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getValue' } }],
		},
		{
			code: "import { OptionResolver } from 'seyfert';\ndeclare const value: InstanceType<typeof OptionResolver>;\nconst { transformOption: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'transformOption' } }],
		},
		{
			code: "import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { end: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'end' } }],
		},
		{
			code: "import { Poll } from 'seyfert';\ndeclare const value: InstanceType<typeof Poll>;\nconst { getAnswerVoters: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getAnswerVoters' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { addAnswers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addAnswers' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { allowMultiselect: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'allowMultiselect' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { setAnswers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setAnswers' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { setDuration: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDuration' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { setQuestion: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setQuestion' } }],
		},
		{
			code: "import { PollBuilder } from 'seyfert';\ndeclare const value: InstanceType<typeof PollBuilder>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { addOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addOptions' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { setOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setOptions' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { RadioGroup } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroup>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { setDefault: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefault' } }],
		},
		{
			code: "import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { setLabel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLabel' } }],
		},
		{
			code: "import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { setValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setValue' } }],
		},
		{
			code: "import { RadioGroupOption } from 'seyfert';\ndeclare const value: InstanceType<typeof RadioGroupOption>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { RoleSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof RoleSelectMenu>;\nconst { addDefaultRoles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addDefaultRoles' } }],
		},
		{
			code: "import { RoleSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof RoleSelectMenu>;\nconst { setDefaultRoles: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefaultRoles' } }],
		},
		{
			code: "import { RoleSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof RoleSelectMenuInteraction>;\nconst { isRoleSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } }],
		},
		{
			code: "import { Router } from 'seyfert';\ndeclare const value: InstanceType<typeof Router>;\nconst { createProxy: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'createProxy' } }],
		},
		{
			code: "import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { addComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addComponents' } }],
		},
		{
			code: "import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { setAccessory: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setAccessory' } }],
		},
		{
			code: "import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { setComponents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setComponents' } }],
		},
		{
			code: "import { Section } from 'seyfert';\ndeclare const value: InstanceType<typeof Section>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { SelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof SelectMenu>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { SelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof SelectMenuInteraction>;\nconst { deferReply: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			code: "import { Separator } from 'seyfert';\ndeclare const value: InstanceType<typeof Separator>;\nconst { setDivider: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDivider' } }],
		},
		{
			code: "import { Separator } from 'seyfert';\ndeclare const value: InstanceType<typeof Separator>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { Separator } from 'seyfert';\ndeclare const value: InstanceType<typeof Separator>;\nconst { setSpacing: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpacing' } }],
		},
		{
			code: "import { SeyfertError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertError>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { SeyfertPluginAggregateError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginAggregateError>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { SeyfertPluginError } from 'seyfert';\ndeclare const value: InstanceType<typeof SeyfertPluginError>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { calculateShardId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { create: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'create' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { disconnect: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'disconnect' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { disconnectAll: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'disconnectAll' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { forceIdentify: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'forceIdentify' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { joinVoice: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'joinVoice' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { leaveVoice: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'leaveVoice' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { requestChannelInfo: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'requestChannelInfo' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { resume: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'resume' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { send: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'send' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { setPresence: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setPresence' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { setShardPresence: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setShardPresence' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { spawnBuckets: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'spawnBuckets' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { spawnShards: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'spawnShards' } }],
		},
		{
			code: "import { ShardManager } from 'seyfert';\ndeclare const value: InstanceType<typeof ShardManager>;\nconst { startResharder: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'startResharder' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { members: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'members' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { setBitrate: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setBitrate' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { setRTC: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRTC' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { setUserLimit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setUserLimit' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { setVideoQuality: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setVideoQuality' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { setVoiceStatus: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setVoiceStatus' } }],
		},
		{
			code: "import { StageChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof StageChannel>;\nconst { states: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'states' } }],
		},
		{
			code: "import { Sticker } from 'seyfert';\ndeclare const value: InstanceType<typeof Sticker>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { Sticker } from 'seyfert';\ndeclare const value: InstanceType<typeof Sticker>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { Sticker } from 'seyfert';\ndeclare const value: InstanceType<typeof Sticker>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { Sticker } from 'seyfert';\ndeclare const value: InstanceType<typeof Sticker>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { StringSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenu>;\nconst { addOption: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addOption' } }],
		},
		{
			code: "import { StringSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenu>;\nconst { setOptions: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setOptions' } }],
		},
		{
			code: "import { StringSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenu>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { StringSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenu>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { StringSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectMenuInteraction>;\nconst { isStringSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { setDefault: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefault' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { setEmoji: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setEmoji' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { setLabel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLabel' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { setValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setValue' } }],
		},
		{
			code: "import { StringSelectOption } from 'seyfert';\ndeclare const value: InstanceType<typeof StringSelectOption>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { SubCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof SubCommand>;\nconst { run: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'run' } }],
		},
		{
			code: "import { SubCommand } from 'seyfert';\ndeclare const value: InstanceType<typeof SubCommand>;\nconst { toJSON: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			code: "import { TextBaseGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof TextBaseGuildChannel>;\nconst { typing: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			code: "import { TextDisplay } from 'seyfert';\ndeclare const value: InstanceType<typeof TextDisplay>;\nconst { setContent: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setContent' } }],
		},
		{
			code: "import { TextDisplay } from 'seyfert';\ndeclare const value: InstanceType<typeof TextDisplay>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { TextGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof TextGuildChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setCustomId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setLength: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLength' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setPlaceholder: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setPlaceholder' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setRequired: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRequired' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setStyle: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setStyle' } }],
		},
		{
			code: "import { TextInput } from 'seyfert';\ndeclare const value: InstanceType<typeof TextInput>;\nconst { setValue: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setValue' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { join: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'join' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { leave: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'leave' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { pin: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'pin' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setArchived: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setArchived' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setAutoArchiveDuration: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setAutoArchiveDuration' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setInvitable: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setInvitable' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setLocked: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setLocked' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setRatelimitPerUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRatelimitPerUser' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { setTags: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTags' } }],
		},
		{
			code: "import { ThreadChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadChannel>;\nconst { unpin: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'unpin' } }],
		},
		{
			code: "import { ThreadOnlyMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof ThreadOnlyMethods>;\nconst { thread: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'thread' } }],
		},
		{
			code: "import { Thumbnail } from 'seyfert';\ndeclare const value: InstanceType<typeof Thumbnail>;\nconst { setDescription: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDescription' } }],
		},
		{
			code: "import { Thumbnail } from 'seyfert';\ndeclare const value: InstanceType<typeof Thumbnail>;\nconst { setId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setId' } }],
		},
		{
			code: "import { Thumbnail } from 'seyfert';\ndeclare const value: InstanceType<typeof Thumbnail>;\nconst { setMedia: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMedia' } }],
		},
		{
			code: "import { Thumbnail } from 'seyfert';\ndeclare const value: InstanceType<typeof Thumbnail>;\nconst { setSpoiler: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } }],
		},
		{
			code: "import { TopicableGuildChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof TopicableGuildChannel>;\nconst { setTopic: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTopic' } }],
		},
		{
			code: "import { UnavailableMember } from 'seyfert';\ndeclare const value: InstanceType<typeof UnavailableMember>;\nconst { ban: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'ban' } }],
		},
		{
			code: "import { User } from 'seyfert';\ndeclare const value: InstanceType<typeof User>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { UserCommandInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserCommandInteraction>;\nconst { isUser: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUser' } }],
		},
		{
			code: "import { UserSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenu>;\nconst { addDefaultUsers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addDefaultUsers' } }],
		},
		{
			code: "import { UserSelectMenu } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenu>;\nconst { setDefaultUsers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDefaultUsers' } }],
		},
		{
			code: "import { UserSelectMenuInteraction } from 'seyfert';\ndeclare const value: InstanceType<typeof UserSelectMenuInteraction>;\nconst { isUserSelectMenu: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } }],
		},
		{
			code: "import { VoiceChannel } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceChannel>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { VoiceChannelMethods } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceChannelMethods>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { disconnect: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'disconnect' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { member: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'member' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { requestSpeak: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'requestSpeak' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { setChannel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setChannel' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { setDeaf: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setDeaf' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { setMute: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setMute' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { setSuppress: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setSuppress' } }],
		},
		{
			code: "import { VoiceState } from 'seyfert';\ndeclare const value: InstanceType<typeof VoiceState>;\nconst { user: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'user' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { avatarURL: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarURL' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { channel: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'channel' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { Webhook } from 'seyfert';\ndeclare const value: InstanceType<typeof Webhook>;\nconst { guild: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'guild' } }],
		},
		{
			code: "import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { delete: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			code: "import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { edit: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'edit' } }],
		},
		{
			code: "import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { fetch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			code: "import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { fetchWebhook: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetchWebhook' } }],
		},
		{
			code: "import { WebhookMessage } from 'seyfert';\ndeclare const value: InstanceType<typeof WebhookMessage>;\nconst { write: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'write' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { addToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { bulkAddToRelationShip: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { bulkGet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkGet' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { bulkPatch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { bulkRemove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { bulkSet: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'bulkSet' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { contains: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'contains' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { count: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'count' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { flush: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'flush' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { get: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'get' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { getToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { keys: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'keys' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { patch: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'patch' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { postMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'postMessage' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { remove: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'remove' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { removeRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { removeToRelationship: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { scan: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'scan' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { send: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'send' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { set: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'set' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { WorkerAdapter } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerAdapter>;\nconst { values: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'values' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { calculateShardId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { createShard: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'createShard' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { handleManagerMessages: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'handleManagerMessages' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { loadEvents: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'loadEvents' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { onPacket: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'onPacket' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { postMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'postMessage' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { resumeShard: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'resumeShard' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { setServices: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setServices' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { setWorkerData: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setWorkerData' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { tellWorker: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'tellWorker' } }],
		},
		{
			code: "import { WorkerClient } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerClient>;\nconst { tellWorkers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'tellWorkers' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { calculateShardId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { calculateWorkerId: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'calculateWorkerId' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { createWorker: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'createWorker' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { getShardInfo: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getShardInfo' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { getWorkerInfo: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'getWorkerInfo' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { handleWorkerMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'handleWorkerMessage' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { postMessage: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'postMessage' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { prepareWorkers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'prepareWorkers' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { send: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'send' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { setCache: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCache' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { setRest: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'setRest' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { spawn: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'spawn' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { start: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'start' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { startResharding: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'startResharding' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { syncLatency: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'syncLatency' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { tellWorker: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'tellWorker' } }],
		},
		{
			code: "import { WorkerManager } from 'seyfert';\ndeclare const value: InstanceType<typeof WorkerManager>;\nconst { tellWorkers: _v } = value;",
			errors: [{ messageId: 'methodDestructure', data: { name: 'tellWorkers' } }],
		},
	],
});
