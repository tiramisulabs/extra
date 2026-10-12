import { join } from 'node:path';
import { ESLintUtils } from '@typescript-eslint/utils';
import noMethodDestructureFactory from '../src/rules/noMethodDestructure';
import { createTester } from './_tester';

const createRule = ESLintUtils.RuleCreator(() => 'https://example.com/seyfert-eslint/no-method-destructure');
const rule = noMethodDestructureFactory(createRule);

// One representative per distinct Seyfert declaration, including overloads.
// Group members by receiver to reuse the TS program; every destructure statement
// and exact diagnostic remains independent. Keep the seven manual regressions.
const filename = join(import.meta.dirname, 'fixtures', 'anchor.ts');

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
		{
			name: 'ActionRow: safe properties',
			filename,
			code: `import { ActionRow } from 'seyfert';
declare const value: InstanceType<typeof ActionRow>;
const { components: _v0 } = value;
const { data: _v1 } = value;`,
		},
		{
			name: 'AnonymousGuild: safe properties',
			filename,
			code: `import { AnonymousGuild } from 'seyfert';
declare const value: InstanceType<typeof AnonymousGuild>;
const { client: _v0 } = value;
const { createdAt: _v1 } = value;
const { createdTimestamp: _v2 } = value;
const { id: _v3 } = value;
const { partnered: _v4 } = value;
const { shard: _v5 } = value;
const { shardId: _v6 } = value;
const { verified: _v7 } = value;`,
		},
		{
			name: 'ApiHandler: safe properties',
			filename,
			code: `import { ApiHandler } from 'seyfert';
declare const value: InstanceType<typeof ApiHandler>;
const { cdn: _v0 } = value;
const { debug: _v1 } = value;
const { debugger: _v2 } = value;
const { globalBlock: _v3 } = value;
const { notifyFailRequest: _v4 } = value;
const { notifyRatelimit: _v5 } = value;
const { notifyRequest: _v6 } = value;
const { notifyRestObserverEntries: _v7 } = value;
const { notifyRestObservers: _v8 } = value;
const { notifySuccessRequest: _v9 } = value;
const { onFailRequest: _v10 } = value;
const { onRatelimit: _v11 } = value;
const { onSuccessRequest: _v12 } = value;
const { options: _v13 } = value;
const { pluginRestObserverClient: _v14 } = value;
const { pluginRestObserverProvider: _v15 } = value;
const { proxy: _v16 } = value;
const { ratelimits: _v17 } = value;
const { readyQueue: _v18 } = value;
const { restObservers: _v19 } = value;
const { workerPromises: _v20 } = value;`,
		},
		{
			name: 'ApplicationCommandInteraction: safe properties',
			filename,
			code: `import { ApplicationCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof ApplicationCommandInteraction>;
const { appPermissions: _v0 } = value;
const { channel: _v1 } = value;
const { client: _v2 } = value;
const { deferred: _v3 } = value;
const { entitlements: _v4 } = value;
const { matchReplied: _v5 } = value;
const { member: _v6 } = value;
const { message: _v7 } = value;
const { replied: _v8 } = value;
const { type: _v9 } = value;
const { user: _v10 } = value;`,
		},
		{
			name: 'ApplicationEmoji: safe properties',
			filename,
			code: `import { ApplicationEmoji } from 'seyfert';
declare const value: InstanceType<typeof ApplicationEmoji>;
const { user: _v0 } = value;`,
		},
		{
			name: 'Attachment: safe properties',
			filename,
			code: `import { Attachment } from 'seyfert';
declare const value: InstanceType<typeof Attachment>;
const { data: _v0 } = value;`,
		},
		{
			name: 'AttachmentBuilder: safe properties',
			filename,
			code: `import { AttachmentBuilder } from 'seyfert';
declare const value: InstanceType<typeof AttachmentBuilder>;
const { data: _v0 } = value;
const { spoiler: _v1 } = value;`,
		},
		{
			name: 'AutocompleteInteraction: safe properties',
			filename,
			code: `import { AutocompleteInteraction } from 'seyfert';
declare const value: InstanceType<typeof AutocompleteInteraction>;
const { channel: _v0 } = value;
const { data: _v1 } = value;
const { entitlements: _v2 } = value;
const { options: _v3 } = value;
const { type: _v4 } = value;`,
		},
		{
			name: 'BaseChannel: safe properties',
			filename,
			code: `import { BaseChannel } from 'seyfert';
declare const value: InstanceType<typeof BaseChannel>;
const { type: _v0 } = value;
const { url: _v1 } = value;`,
		},
		{
			name: 'BaseCommand: safe properties',
			filename,
			code: `import { BaseCommand } from 'seyfert';
declare const value: InstanceType<typeof BaseCommand>;
const { aliases: _v0 } = value;
const { botPermissions: _v1 } = value;
const { contexts: _v2 } = value;
const { defaultMemberPermissions: _v3 } = value;
const { description: _v4 } = value;
const { description_localizations: _v5 } = value;
const { guildId: _v6 } = value;
const { ignore: _v7 } = value;
const { integrationTypes: _v8 } = value;
const { middlewares: _v9 } = value;
const { name: _v10 } = value;
const { name_localizations: _v11 } = value;
const { nsfw: _v12 } = value;
const { options: _v13 } = value;
const { props: _v14 } = value;
const { type: _v15 } = value;`,
		},
		{
			name: 'BaseGuildChannel: safe properties',
			filename,
			code: `import { BaseGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof BaseGuildChannel>;
const { guildId: _v0 } = value;
const { invites: _v1 } = value;
const { permissionOverwrites: _v2 } = value;
const { url: _v3 } = value;`,
		},
		{
			name: 'BaseGuildMember: safe properties',
			filename,
			code: `import { BaseGuildMember } from 'seyfert';
declare const value: InstanceType<typeof BaseGuildMember>;
const { communicationDisabledUntilTimestamp: _v0 } = value;
const { guildId: _v1 } = value;
const { hasTimeout: _v2 } = value;
const { joinedTimestamp: _v3 } = value;
const { patch: _v4 } = value;
const { roles: _v5 } = value;`,
		},
		{
			name: 'BaseInteraction: safe properties',
			filename,
			code: `import { BaseInteraction } from 'seyfert';
declare const value: InstanceType<typeof BaseInteraction>;
const { channel: _v0 } = value;`,
		},
		{
			name: 'BaseMessage: safe properties',
			filename,
			code: `import { BaseMessage } from 'seyfert';
declare const value: InstanceType<typeof BaseMessage>;
const { author: _v0 } = value;
const { components: _v1 } = value;
const { embeds: _v2 } = value;
const { guildId: _v3 } = value;
const { member: _v4 } = value;
const { mentions: _v5 } = value;
const { patch: _v6 } = value;
const { poll: _v7 } = value;
const { timestamp: _v8 } = value;
const { url: _v9 } = value;
const { user: _v10 } = value;`,
		},
		{
			name: 'BaseResource: safe properties',
			filename,
			code: `import { BaseResource } from 'seyfert';
declare const value: InstanceType<typeof BaseResource>;
const { adapter: _v0 } = value;
const { cache: _v1 } = value;
const { client: _v2 } = value;
const { namespace: _v3 } = value;`,
		},
		{
			name: 'ButtonInteraction: safe properties',
			filename,
			code: `import { ButtonInteraction } from 'seyfert';
declare const value: InstanceType<typeof ButtonInteraction>;
const { channel: _v0 } = value;
const { componentType: _v1 } = value;
const { customId: _v2 } = value;
const { data: _v3 } = value;
const { entitlements: _v4 } = value;
const { message: _v5 } = value;
const { type: _v6 } = value;`,
		},
		{
			name: 'Cache: safe properties',
			filename,
			code: `import { Cache } from 'seyfert';
declare const value: InstanceType<typeof Cache>;
const { adapter: _v0 } = value;
const { bans: _v1 } = value;
const { channels: _v2 } = value;
const { emojis: _v3 } = value;
const { guilds: _v4 } = value;
const { hasChannelsIntent: _v5 } = value;
const { hasDirectMessages: _v6 } = value;
const { hasGuildExpressionsIntent: _v7 } = value;
const { hasGuildMembersIntent: _v8 } = value;
const { hasGuildsIntent: _v9 } = value;
const { hasModerationIntent: _v10 } = value;
const { hasPresenceUpdates: _v11 } = value;
const { hasRolesIntent: _v12 } = value;
const { hasVoiceStatesIntent: _v13 } = value;
const { intents: _v14 } = value;
const { members: _v15 } = value;
const { messages: _v16 } = value;
const { onPacketWithPluginResources: _v17 } = value;
const { overwrites: _v18 } = value;
const { pluginResourceNames: _v19 } = value;
const { pluginResourcePacketErrorLogger: _v20 } = value;
const { pluginResourcePacketHandlers: _v21 } = value;
const { presences: _v22 } = value;
const { roles: _v23 } = value;
const { stageInstances: _v24 } = value;
const { stickers: _v25 } = value;
const { testChannelsAndOverwrites: _v26 } = value;
const { testUsersAndMembers: _v27 } = value;
const { users: _v28 } = value;
const { voiceStates: _v29 } = value;`,
		},
		{
			name: 'CategoryChannel: safe properties',
			filename,
			code: `import { CategoryChannel } from 'seyfert';
declare const value: InstanceType<typeof CategoryChannel>;
const { type: _v0 } = value;`,
		},
		{
			name: 'ChannelSelectMenuInteraction: safe properties',
			filename,
			code: `import { ChannelSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof ChannelSelectMenuInteraction>;
const { channel: _v0 } = value;
const { channels: _v1 } = value;
const { data: _v2 } = value;
const { values: _v3 } = value;`,
		},
		{
			name: 'ChatInputCommandInteraction: safe properties',
			filename,
			code: `import { ChatInputCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof ChatInputCommandInteraction>;
const { channel: _v0 } = value;
const { data: _v1 } = value;`,
		},
		{
			name: 'CheckboxGroupOption: safe properties',
			filename,
			code: `import { CheckboxGroupOption } from 'seyfert';
declare const value: InstanceType<typeof CheckboxGroupOption>;
const { data: _v0 } = value;`,
		},
		{
			name: 'ClientUser: safe properties',
			filename,
			code: `import { ClientUser } from 'seyfert';
declare const value: InstanceType<typeof ClientUser>;
const { application: _v0 } = value;
const { bot: _v1 } = value;
const { name: _v2 } = value;
const { tag: _v3 } = value;`,
		},
		{
			name: 'Collectors: safe properties',
			filename,
			code: `import { Collectors } from 'seyfert';
declare const value: InstanceType<typeof Collectors>;
const { delete: _v0 } = value;
const { generateRandomUUID: _v1 } = value;
const { values: _v2 } = value;`,
		},
		{
			name: 'Command: safe properties',
			filename,
			code: `import { Command } from 'seyfert';
declare const value: InstanceType<typeof Command>;
const { groups: _v0 } = value;
const { groupsAliases: _v1 } = value;
const { type: _v2 } = value;`,
		},
		{
			name: 'CommandContext: safe properties',
			filename,
			code: `import { CommandContext } from 'seyfert';
declare const value: InstanceType<typeof CommandContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { command: _v3 } = value;
const { deferred: _v4 } = value;
const { fullCommandName: _v5 } = value;
const { globalMetadata: _v6 } = value;
const { guildId: _v7 } = value;
const { interaction: _v8 } = value;
const { member: _v9 } = value;
const { message: _v10 } = value;
const { messageResponse: _v11 } = value;
const { metadata: _v12 } = value;
const { options: _v13 } = value;
const { proxy: _v14 } = value;
const { resolver: _v15 } = value;
const { shardId: _v16 } = value;
const { t: _v17 } = value;`,
		},
		{
			name: 'ComponentCommand: safe properties',
			filename,
			code: `import { ComponentCommand } from 'seyfert';
declare const value: InstanceType<typeof ComponentCommand>;
const { componentType: _v0 } = value;
const { cType: _v1 } = value;
const { customId: _v2 } = value;
const { middlewares: _v3 } = value;
const { props: _v4 } = value;
const { type: _v5 } = value;`,
		},
		{
			name: 'ComponentContext: safe properties',
			filename,
			code: `import { ComponentContext } from 'seyfert';
declare const value: InstanceType<typeof ComponentContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { command: _v3 } = value;
const { customId: _v4 } = value;
const { globalMetadata: _v5 } = value;
const { guildId: _v6 } = value;
const { interaction: _v7 } = value;
const { member: _v8 } = value;
const { message: _v9 } = value;
const { metadata: _v10 } = value;
const { t: _v11 } = value;`,
		},
		{
			name: 'ComponentInteraction: safe properties',
			filename,
			code: `import { ComponentInteraction } from 'seyfert';
declare const value: InstanceType<typeof ComponentInteraction>;
const { data: _v0 } = value;`,
		},
		{
			name: 'Container: safe properties',
			filename,
			code: `import { Container } from 'seyfert';
declare const value: InstanceType<typeof Container>;
const { components: _v0 } = value;`,
		},
		{
			name: 'ContextMenuCommand: safe properties',
			filename,
			code: `import { ContextMenuCommand } from 'seyfert';
declare const value: InstanceType<typeof ContextMenuCommand>;
const { botPermissions: _v0 } = value;
const { contexts: _v1 } = value;
const { defaultMemberPermissions: _v2 } = value;
const { description: _v3 } = value;
const { description_localizations: _v4 } = value;
const { dm: _v5 } = value;
const { guildId: _v6 } = value;
const { integrationTypes: _v7 } = value;
const { middlewares: _v8 } = value;
const { name: _v9 } = value;
const { name_localizations: _v10 } = value;
const { nsfw: _v11 } = value;
const { props: _v12 } = value;
const { type: _v13 } = value;`,
		},
		{
			name: 'CustomEventHandler: safe properties',
			filename,
			code: `import { CustomEventHandler } from 'seyfert';
declare const value: InstanceType<typeof CustomEventHandler>;
const { client: _v0 } = value;
const { filter: _v1 } = value;
const { logger: _v2 } = value;
const { onFail: _v3 } = value;
const { values: _v4 } = value;`,
		},
		{
			name: 'DirectoryChannel: safe properties',
			filename,
			code: `import { DirectoryChannel } from 'seyfert';
declare const value: InstanceType<typeof DirectoryChannel>;
const { guildId: _v0 } = value;`,
		},
		{
			name: 'DMChannel: safe properties',
			filename,
			code: `import { DMChannel } from 'seyfert';
declare const value: InstanceType<typeof DMChannel>;
const { messages: _v0 } = value;
const { pins: _v1 } = value;
const { reactions: _v2 } = value;
const { type: _v3 } = value;`,
		},
		{
			name: 'Embed: safe properties',
			filename,
			code: `import { Embed } from 'seyfert';
declare const value: InstanceType<typeof Embed>;
const { data: _v0 } = value;`,
		},
		{
			name: 'Entitlement: safe properties',
			filename,
			code: `import { Entitlement } from 'seyfert';
declare const value: InstanceType<typeof Entitlement>;
const { endsAtTimestamp: _v0 } = value;
const { startsAtTimestamp: _v1 } = value;`,
		},
		{
			name: 'EntryPointCommand: safe properties',
			filename,
			code: `import { EntryPointCommand } from 'seyfert';
declare const value: InstanceType<typeof EntryPointCommand>;
const { botPermissions: _v0 } = value;
const { contexts: _v1 } = value;
const { description: _v2 } = value;
const { description_localizations: _v3 } = value;
const { dm: _v4 } = value;
const { handler: _v5 } = value;
const { integrationTypes: _v6 } = value;
const { middlewares: _v7 } = value;
const { name: _v8 } = value;
const { name_localizations: _v9 } = value;
const { nsfw: _v10 } = value;
const { props: _v11 } = value;
const { type: _v12 } = value;`,
		},
		{
			name: 'EntryPointContext: safe properties',
			filename,
			code: `import { EntryPointContext } from 'seyfert';
declare const value: InstanceType<typeof EntryPointContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { command: _v3 } = value;
const { deferred: _v4 } = value;
const { fullCommandName: _v5 } = value;
const { globalMetadata: _v6 } = value;
const { guildId: _v7 } = value;
const { interaction: _v8 } = value;
const { member: _v9 } = value;
const { metadata: _v10 } = value;
const { shardId: _v11 } = value;
const { t: _v12 } = value;`,
		},
		{
			name: 'EntryPointInteraction: safe properties',
			filename,
			code: `import { EntryPointInteraction } from 'seyfert';
declare const value: InstanceType<typeof EntryPointInteraction>;
const { channel: _v0 } = value;`,
		},
		{
			name: 'EventHandler: safe properties',
			filename,
			code: `import { EventHandler } from 'seyfert';
declare const value: InstanceType<typeof EventHandler>;
const { callback: _v0 } = value;
const { client: _v1 } = value;
const { discordEvents: _v2 } = value;
const { filter: _v3 } = value;`,
		},
		{
			name: 'ForumChannel: safe properties',
			filename,
			code: `import { ForumChannel } from 'seyfert';
declare const value: InstanceType<typeof ForumChannel>;
const { type: _v0 } = value;
const { webhooks: _v1 } = value;`,
		},
		{
			name: 'Guild: safe properties',
			filename,
			code: `import { Guild } from 'seyfert';
declare const value: InstanceType<typeof Guild>;
const { bans: _v0 } = value;
const { channels: _v1 } = value;
const { emojis: _v2 } = value;
const { invites: _v3 } = value;
const { joinedAt: _v4 } = value;
const { large: _v5 } = value;
const { maxEmojis: _v6 } = value;
const { maxStickers: _v7 } = value;
const { memberCount: _v8 } = value;
const { members: _v9 } = value;
const { moderationRules: _v10 } = value;
const { roles: _v11 } = value;
const { stickers: _v12 } = value;
const { templates: _v13 } = value;
const { unavailable: _v14 } = value;
const { webhooks: _v15 } = value;`,
		},
		{
			name: 'GuildBan: safe properties',
			filename,
			code: `import { GuildBan } from 'seyfert';
declare const value: InstanceType<typeof GuildBan>;
const { guildId: _v0 } = value;`,
		},
		{
			name: 'GuildBasedResource: safe properties',
			filename,
			code: `import { GuildBasedResource } from 'seyfert';
declare const value: InstanceType<typeof GuildBasedResource>;
const { adapter: _v0 } = value;
const { cache: _v1 } = value;
const { client: _v2 } = value;
const { namespace: _v3 } = value;`,
		},
		{
			name: 'GuildEmoji: safe properties',
			filename,
			code: `import { GuildEmoji } from 'seyfert';
declare const value: InstanceType<typeof GuildEmoji>;
const { guildId: _v0 } = value;`,
		},
		{
			name: 'GuildMember: safe properties',
			filename,
			code: `import { GuildMember } from 'seyfert';
declare const value: InstanceType<typeof GuildMember>;
const { bot: _v0 } = value;
const { displayName: _v1 } = value;
const { globalName: _v2 } = value;
const { guildId: _v3 } = value;
const { name: _v4 } = value;
const { tag: _v5 } = value;
const { user: _v6 } = value;
const { username: _v7 } = value;`,
		},
		{
			name: 'GuildRelatedResource: safe properties',
			filename,
			code: `import { GuildRelatedResource } from 'seyfert';
declare const value: InstanceType<typeof GuildRelatedResource>;
const { adapter: _v0 } = value;
const { cache: _v1 } = value;
const { client: _v2 } = value;
const { namespace: _v3 } = value;`,
		},
		{
			name: 'GuildRole: safe properties',
			filename,
			code: `import { GuildRole } from 'seyfert';
declare const value: InstanceType<typeof GuildRole>;
const { guildId: _v0 } = value;
const { permissions: _v1 } = value;`,
		},
		{
			name: 'HttpClient: safe properties',
			filename,
			code: `import { HttpClient } from 'seyfert';
declare const value: InstanceType<typeof HttpClient>;
const { applicationId: _v0 } = value;
const { applications: _v1 } = value;
const { applyPluginCommands: _v2 } = value;
const { applyPluginComponents: _v3 } = value;
const { applyPluginLangs: _v4 } = value;
const { bans: _v5 } = value;
const { bindPluginLangReload: _v6 } = value;
const { bindPluginRestObserverProvider: _v7 } = value;
const { botId: _v8 } = value;
const { cache: _v9 } = value;
const { cachedCommandGuilds: _v10 } = value;
const { channels: _v11 } = value;
const { commands: _v12 } = value;
const { components: _v13 } = value;
const { createPluginCommandInstance: _v14 } = value;
const { createPluginComponentInstance: _v15 } = value;
const { createPluginLoadedMetadata: _v16 } = value;
const { debugger: _v17 } = value;
const { emitPluginCustomEvent: _v18 } = value;
const { emitUploadCommandsMetadata: _v19 } = value;
const { emojis: _v20 } = value;
const { events: _v21 } = value;
const { guilds: _v22 } = value;
const { handleCommand: _v23 } = value;
const { interactions: _v24 } = value;
const { invites: _v25 } = value;
const { langBaseValues: _v26 } = value;
const { langs: _v27 } = value;
const { loadedCommands: _v28 } = value;
const { logger: _v29 } = value;
const { matchesPluginHandlerKind: _v30 } = value;
const { members: _v31 } = value;
const { messages: _v32 } = value;
const { middlewares: _v33 } = value;
const { options: _v34 } = value;
const { pluginBaseGatewayIntents: _v35 } = value;
const { pluginCacheDisabledCache: _v36 } = value;
const { pluginComponentsBeforeLoadDepth: _v37 } = value;
const { plugins: _v38 } = value;
const { pluginsClosePromise: _v39 } = value;
const { pluginsSetupPromise: _v40 } = value;
const { proxy: _v41 } = value;
const { reactions: _v42 } = value;
const { refreshPluginCacheResources: _v43 } = value;
const { reloadPluginCommands: _v44 } = value;
const { reloadPluginComponents: _v45 } = value;
const { reloadPluginMiddlewares: _v46 } = value;
const { rest: _v47 } = value;
const { roles: _v48 } = value;
const { runPluginHandlerCreators: _v49 } = value;
const { setupPlugins: _v50 } = value;
const { shared: _v51 } = value;
const { shouldUploadCommands: _v52 } = value;
const { soundboards: _v53 } = value;
const { syncCachePath: _v54 } = value;
const { templates: _v55 } = value;
const { threads: _v56 } = value;
const { users: _v57 } = value;
const { voiceStates: _v58 } = value;
const { webhooks: _v59 } = value;`,
		},
		{
			name: 'InMessageEmbed: safe properties',
			filename,
			code: `import { InMessageEmbed } from 'seyfert';
declare const value: InstanceType<typeof InMessageEmbed>;
const { author: _v0 } = value;
const { color: _v1 } = value;
const { data: _v2 } = value;
const { description: _v3 } = value;
const { fields: _v4 } = value;
const { footer: _v5 } = value;
const { image: _v6 } = value;
const { provider: _v7 } = value;
const { thumbnail: _v8 } = value;
const { timestamp: _v9 } = value;
const { title: _v10 } = value;
const { type: _v11 } = value;
const { url: _v12 } = value;
const { video: _v13 } = value;`,
		},
		{
			name: 'Interaction: safe properties',
			filename,
			code: `import { Interaction } from 'seyfert';
declare const value: InstanceType<typeof Interaction>;
const { channel: _v0 } = value;`,
		},
		{
			name: 'InteractionGuildMember: safe properties',
			filename,
			code: `import { InteractionGuildMember } from 'seyfert';
declare const value: InstanceType<typeof InteractionGuildMember>;
const { permissions: _v0 } = value;`,
		},
		{
			name: 'InteractionResponseContext: safe properties',
			filename,
			code: `import { InteractionResponseContext } from 'seyfert';
declare const value: InstanceType<typeof InteractionResponseContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { customId: _v3 } = value;
const { globalMetadata: _v4 } = value;
const { guildId: _v5 } = value;
const { interaction: _v6 } = value;
const { member: _v7 } = value;
const { metadata: _v8 } = value;
const { t: _v9 } = value;`,
		},
		{
			name: 'Label: safe properties',
			filename,
			code: `import { Label } from 'seyfert';
declare const value: InstanceType<typeof Label>;
const { component: _v0 } = value;`,
		},
		{
			name: 'LangsHandler: safe properties',
			filename,
			code: `import { LangsHandler } from 'seyfert';
declare const value: InstanceType<typeof LangsHandler>;
const { aliases: _v0 } = value;
const { applyParsedFile: _v1 } = value;
const { defaultLang: _v2 } = value;
const { filter: _v3 } = value;
const { onReload: _v4 } = value;
const { preferGuildLocale: _v5 } = value;
const { values: _v6 } = value;`,
		},
		{
			name: 'LimitedCollection: safe properties',
			filename,
			code: `import { LimitedCollection } from 'seyfert';
declare const value: InstanceType<typeof LimitedCollection>;
const { clearExpired: _v0 } = value;
const { closer: _v1 } = value;
const { data: _v2 } = value;
const { expirations: _v3 } = value;
const { options: _v4 } = value;
const { resetTimeout: _v5 } = value;
const { size: _v6 } = value;
const { startTimeout: _v7 } = value;
const { stopTimeout: _v8 } = value;
const { timeout: _v9 } = value;`,
		},
		{
			name: 'LimitedMemoryAdapter: safe properties',
			filename,
			code: `import { LimitedMemoryAdapter } from 'seyfert';
declare const value: InstanceType<typeof LimitedMemoryAdapter>;
const { isAsync: _v0 } = value;
const { keyToStorage: _v1 } = value;
const { options: _v2 } = value;
const { relationships: _v3 } = value;
const { storage: _v4 } = value;`,
		},
		{
			name: 'Logger: safe properties',
			filename,
			code: `import { Logger } from 'seyfert';
declare const value: InstanceType<typeof Logger>;
const { active: _v0 } = value;
const { level: _v1 } = value;
const { name: _v2 } = value;
const { options: _v3 } = value;
const { saveOnFile: _v4 } = value;`,
		},
		{
			name: 'MediaChannel: safe properties',
			filename,
			code: `import { MediaChannel } from 'seyfert';
declare const value: InstanceType<typeof MediaChannel>;
const { type: _v0 } = value;`,
		},
		{
			name: 'MediaGallery: safe properties',
			filename,
			code: `import { MediaGallery } from 'seyfert';
declare const value: InstanceType<typeof MediaGallery>;
const { items: _v0 } = value;`,
		},
		{
			name: 'MediaGalleryItem: safe properties',
			filename,
			code: `import { MediaGalleryItem } from 'seyfert';
declare const value: InstanceType<typeof MediaGalleryItem>;
const { data: _v0 } = value;`,
		},
		{
			name: 'MemoryAdapter: safe properties',
			filename,
			code: `import { MemoryAdapter } from 'seyfert';
declare const value: InstanceType<typeof MemoryAdapter>;
const { isAsync: _v0 } = value;
const { options: _v1 } = value;
const { relationships: _v2 } = value;
const { storage: _v3 } = value;`,
		},
		{
			name: 'MentionableSelectMenuInteraction: safe properties',
			filename,
			code: `import { MentionableSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof MentionableSelectMenuInteraction>;
const { channel: _v0 } = value;
const { members: _v1 } = value;
const { roles: _v2 } = value;
const { users: _v3 } = value;`,
		},
		{
			name: 'MenuCommandContext: safe properties',
			filename,
			code: `import { MenuCommandContext } from 'seyfert';
declare const value: InstanceType<typeof MenuCommandContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { command: _v3 } = value;
const { deferred: _v4 } = value;
const { fullCommandName: _v5 } = value;
const { globalMetadata: _v6 } = value;
const { guildId: _v7 } = value;
const { interaction: _v8 } = value;
const { member: _v9 } = value;
const { metadata: _v10 } = value;
const { shardId: _v11 } = value;
const { t: _v12 } = value;
const { target: _v13 } = value;`,
		},
		{
			name: 'MessageCommandInteraction: safe properties',
			filename,
			code: `import { MessageCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof MessageCommandInteraction>;
const { channel: _v0 } = value;
const { data: _v1 } = value;
const { type: _v2 } = value;`,
		},
		{
			name: 'Modal: safe properties',
			filename,
			code: `import { Modal } from 'seyfert';
declare const value: InstanceType<typeof Modal>;
const { components: _v0 } = value;
const { data: _v1 } = value;`,
		},
		{
			name: 'ModalCommand: safe properties',
			filename,
			code: `import { ModalCommand } from 'seyfert';
declare const value: InstanceType<typeof ModalCommand>;
const { customId: _v0 } = value;
const { middlewares: _v1 } = value;
const { props: _v2 } = value;
const { type: _v3 } = value;`,
		},
		{
			name: 'ModalContext: safe properties',
			filename,
			code: `import { ModalContext } from 'seyfert';
declare const value: InstanceType<typeof ModalContext>;
const { author: _v0 } = value;
const { channelId: _v1 } = value;
const { client: _v2 } = value;
const { command: _v3 } = value;
const { components: _v4 } = value;
const { customId: _v5 } = value;
const { globalMetadata: _v6 } = value;
const { guildId: _v7 } = value;
const { interaction: _v8 } = value;
const { member: _v9 } = value;
const { metadata: _v10 } = value;
const { t: _v11 } = value;`,
		},
		{
			name: 'ModalSubmitInteraction: safe properties',
			filename,
			code: `import { ModalSubmitInteraction } from 'seyfert';
declare const value: InstanceType<typeof ModalSubmitInteraction>;
const { channel: _v0 } = value;
const { components: _v1 } = value;
const { customId: _v2 } = value;
const { data: _v3 } = value;`,
		},
		{
			name: 'NewsChannel: safe properties',
			filename,
			code: `import { NewsChannel } from 'seyfert';
declare const value: InstanceType<typeof NewsChannel>;
const { type: _v0 } = value;`,
		},
		{
			name: 'OptionResolver: safe properties',
			filename,
			code: `import { OptionResolver } from 'seyfert';
declare const value: InstanceType<typeof OptionResolver>;
const { client: _v0 } = value;
const { fullCommandName: _v1 } = value;
const { getTypedOption: _v2 } = value;
const { group: _v3 } = value;
const { guildId: _v4 } = value;
const { hoistedOptions: _v5 } = value;
const { options: _v6 } = value;
const { parent: _v7 } = value;
const { resolved: _v8 } = value;
const { subCommand: _v9 } = value;`,
		},
		{
			name: 'Poll: safe properties',
			filename,
			code: `import { Poll } from 'seyfert';
declare const value: InstanceType<typeof Poll>;
const { channelId: _v0 } = value;
const { expiryAt: _v1 } = value;
const { expiryTimestamp: _v2 } = value;
const { messageId: _v3 } = value;`,
		},
		{
			name: 'PollBuilder: safe properties',
			filename,
			code: `import { PollBuilder } from 'seyfert';
declare const value: InstanceType<typeof PollBuilder>;
const { data: _v0 } = value;
const { resolvedPollMedia: _v1 } = value;`,
		},
		{
			name: 'RadioGroupOption: safe properties',
			filename,
			code: `import { RadioGroupOption } from 'seyfert';
declare const value: InstanceType<typeof RadioGroupOption>;
const { data: _v0 } = value;`,
		},
		{
			name: 'RoleSelectMenuInteraction: safe properties',
			filename,
			code: `import { RoleSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof RoleSelectMenuInteraction>;
const { channel: _v0 } = value;
const { roles: _v1 } = value;`,
		},
		{
			name: 'Router: safe properties',
			filename,
			code: `import { Router } from 'seyfert';
declare const value: InstanceType<typeof Router>;
const { noop: _v0 } = value;
const { rest: _v1 } = value;`,
		},
		{
			name: 'Section: safe properties',
			filename,
			code: `import { Section } from 'seyfert';
declare const value: InstanceType<typeof Section>;
const { accessory: _v0 } = value;
const { components: _v1 } = value;`,
		},
		{
			name: 'SelectMenuInteraction: safe properties',
			filename,
			code: `import { SelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof SelectMenuInteraction>;
const { channel: _v0 } = value;`,
		},
		{
			name: 'SeyfertError: safe properties',
			filename,
			code: `import { SeyfertError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertError>;
const { code: _v0 } = value;
const { metadata: _v1 } = value;
const { name: _v2 } = value;`,
		},
		{
			name: 'SeyfertPluginAggregateError: safe properties',
			filename,
			code: `import { SeyfertPluginAggregateError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertPluginAggregateError>;
const { cause: _v0 } = value;
const { errors: _v1 } = value;
const { name: _v2 } = value;`,
		},
		{
			name: 'SeyfertPluginError: safe properties',
			filename,
			code: `import { SeyfertPluginError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertPluginError>;
const { index: _v0 } = value;
const { instanceId: _v1 } = value;
const { phase: _v2 } = value;
const { plugin: _v3 } = value;`,
		},
		{
			name: 'ShardManager: safe properties',
			filename,
			code: `import { ShardManager } from 'seyfert';
declare const value: InstanceType<typeof ShardManager>;
const { concurrency: _v0 } = value;
const { connectQueue: _v1 } = value;
const { debugger: _v2 } = value;
const { latency: _v3 } = value;
const { options: _v4 } = value;
const { remaining: _v5 } = value;
const { resolveSendPayload: _v6 } = value;
const { shardEnd: _v7 } = value;
const { shardStart: _v8 } = value;
const { totalShards: _v9 } = value;`,
		},
		{
			name: 'StageChannel: safe properties',
			filename,
			code: `import { StageChannel } from 'seyfert';
declare const value: InstanceType<typeof StageChannel>;
const { guildId: _v0 } = value;
const { type: _v1 } = value;`,
		},
		{
			name: 'Sticker: safe properties',
			filename,
			code: `import { Sticker } from 'seyfert';
declare const value: InstanceType<typeof Sticker>;
const { user: _v0 } = value;`,
		},
		{
			name: 'StringSelectMenu: safe properties',
			filename,
			code: `import { StringSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof StringSelectMenu>;
const { data: _v0 } = value;`,
		},
		{
			name: 'StringSelectMenuInteraction: safe properties',
			filename,
			code: `import { StringSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof StringSelectMenuInteraction>;
const { channel: _v0 } = value;
const { data: _v1 } = value;
const { values: _v2 } = value;`,
		},
		{
			name: 'StringSelectOption: safe properties',
			filename,
			code: `import { StringSelectOption } from 'seyfert';
declare const value: InstanceType<typeof StringSelectOption>;
const { data: _v0 } = value;`,
		},
		{
			name: 'SubCommand: safe properties',
			filename,
			code: `import { SubCommand } from 'seyfert';
declare const value: InstanceType<typeof SubCommand>;
const { group: _v0 } = value;
const { options: _v1 } = value;
const { type: _v2 } = value;`,
		},
		{
			name: 'TextGuildChannel: safe properties',
			filename,
			code: `import { TextGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof TextGuildChannel>;
const { type: _v0 } = value;`,
		},
		{
			name: 'ThreadChannel: safe properties',
			filename,
			code: `import { ThreadChannel } from 'seyfert';
declare const value: InstanceType<typeof ThreadChannel>;
const { parentId: _v0 } = value;
const { type: _v1 } = value;
const { webhooks: _v2 } = value;`,
		},
		{
			name: 'UnavailableMember: safe properties',
			filename,
			code: `import { UnavailableMember } from 'seyfert';
declare const value: InstanceType<typeof UnavailableMember>;
const { pending: _v0 } = value;`,
		},
		{
			name: 'UserCommandInteraction: safe properties',
			filename,
			code: `import { UserCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof UserCommandInteraction>;
const { channel: _v0 } = value;
const { data: _v1 } = value;
const { type: _v2 } = value;`,
		},
		{
			name: 'UserSelectMenuInteraction: safe properties',
			filename,
			code: `import { UserSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof UserSelectMenuInteraction>;
const { channel: _v0 } = value;
const { members: _v1 } = value;
const { users: _v2 } = value;`,
		},
		{
			name: 'VoiceChannel: safe properties',
			filename,
			code: `import { VoiceChannel } from 'seyfert';
declare const value: InstanceType<typeof VoiceChannel>;
const { guildId: _v0 } = value;
const { type: _v1 } = value;`,
		},
		{
			name: 'VoiceChannelMethods: safe properties',
			filename,
			code: `import { VoiceChannelMethods } from 'seyfert';
declare const value: InstanceType<typeof VoiceChannelMethods>;
const { guildId: _v0 } = value;`,
		},
		{
			name: 'VoiceState: safe properties',
			filename,
			code: `import { VoiceState } from 'seyfert';
declare const value: InstanceType<typeof VoiceState>;
const { isCameraOn: _v0 } = value;
const { isDeafened: _v1 } = value;
const { isMuted: _v2 } = value;
const { isStreaming: _v3 } = value;
const { isSuppressed: _v4 } = value;
const { withMember: _v5 } = value;`,
		},
		{
			name: 'Webhook: safe properties',
			filename,
			code: `import { Webhook } from 'seyfert';
declare const value: InstanceType<typeof Webhook>;
const { messages: _v0 } = value;
const { sourceGuild: _v1 } = value;
const { user: _v2 } = value;`,
		},
		{
			name: 'WebhookChannelMethods: safe properties',
			filename,
			code: `import { WebhookChannelMethods } from 'seyfert';
declare const value: InstanceType<typeof WebhookChannelMethods>;
const { webhooks: _v0 } = value;`,
		},
		{
			name: 'WebhookGuildMethods: safe properties',
			filename,
			code: `import { WebhookGuildMethods } from 'seyfert';
declare const value: InstanceType<typeof WebhookGuildMethods>;
const { webhooks: _v0 } = value;`,
		},
		{
			name: 'WebhookMessage: safe properties',
			filename,
			code: `import { WebhookMessage } from 'seyfert';
declare const value: InstanceType<typeof WebhookMessage>;
const { webhookId: _v0 } = value;
const { webhookToken: _v1 } = value;`,
		},
		{
			name: 'WorkerAdapter: safe properties',
			filename,
			code: `import { WorkerAdapter } from 'seyfert';
declare const value: InstanceType<typeof WorkerAdapter>;
const { isAsync: _v0 } = value;
const { promises: _v1 } = value;
const { workerData: _v2 } = value;`,
		},
		{
			name: 'WorkerClient: safe properties',
			filename,
			code: `import { WorkerClient } from 'seyfert';
declare const value: InstanceType<typeof WorkerClient>;
const { applicationId: _v0 } = value;
const { collectors: _v1 } = value;
const { events: _v2 } = value;
const { generateNonce: _v3 } = value;
const { generateSendPromise: _v4 } = value;
const { latency: _v5 } = value;
const { me: _v6 } = value;
const { memberUpdateHandler: _v7 } = value;
const { onShardDisconnect: _v8 } = value;
const { onShardReconnect: _v9 } = value;
const { options: _v10 } = value;
const { presenceUpdateHandler: _v11 } = value;
const { promises: _v12 } = value;
const { resharding: _v13 } = value;
const { shards: _v14 } = value;
const { workerData: _v15 } = value;
const { workerId: _v16 } = value;`,
		},
		{
			name: 'WorkerManager: safe properties',
			filename,
			code: `import { WorkerManager } from 'seyfert';
declare const value: InstanceType<typeof WorkerManager>;
const { cacheAdapter: _v0 } = value;
const { concurrency: _v1 } = value;
const { connectQueue: _v2 } = value;
const { debugger: _v3 } = value;
const { generateNonce: _v4 } = value;
const { generateSendPromise: _v5 } = value;
const { heartbeater: _v6 } = value;
const { options: _v7 } = value;
const { promises: _v8 } = value;
const { remaining: _v9 } = value;
const { reshardingWorkerQueue: _v10 } = value;
const { resolveSendPayload: _v11 } = value;
const { rest: _v12 } = value;
const { shardEnd: _v13 } = value;
const { shardsPerWorker: _v14 } = value;
const { shardStart: _v15 } = value;
const { totalShards: _v16 } = value;
const { totalWorkers: _v17 } = value;
const { workerQueue: _v18 } = value;`,
		},
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
			name: 'ActionRow: detached methods',
			filename,
			code: `import { ActionRow } from 'seyfert';
declare const value: InstanceType<typeof ActionRow>;
const { addComponents: _v0 } = value;
const { setComponents: _v1 } = value;
const { toJSON: _v2 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'setComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'AnonymousGuild: detached methods',
			filename,
			code: `import { AnonymousGuild } from 'seyfert';
declare const value: InstanceType<typeof AnonymousGuild>;
const { bannerURL: _v0 } = value;
const { fetch: _v1 } = value;
const { iconURL: _v2 } = value;
const { leave: _v3 } = value;
const { splashURL: _v4 } = value;
const { toString: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'bannerURL' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'iconURL' } },
				{ messageId: 'methodDestructure', data: { name: 'leave' } },
				{ messageId: 'methodDestructure', data: { name: 'splashURL' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
			],
		},
		{
			name: 'ApiHandler: detached methods',
			filename,
			code: `import { ApiHandler } from 'seyfert';
declare const value: InstanceType<typeof ApiHandler>;
const { clearResetInterval: _v0 } = value;
const { globalUnblock: _v1 } = value;
const { handle429: _v2 } = value;
const { handle50X: _v3 } = value;
const { observe: _v4 } = value;
const { parseError: _v5 } = value;
const { parseRequest: _v6 } = value;
const { parseValidationError: _v7 } = value;
const { postMessage: _v8 } = value;
const { randomUUID: _v9 } = value;
const { request: _v10 } = value;
const { routefy: _v11 } = value;
const { sendMessage: _v12 } = value;
const { setRatelimitsBucket: _v13 } = value;
const { setResetBucket: _v14 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'clearResetInterval' } },
				{ messageId: 'methodDestructure', data: { name: 'globalUnblock' } },
				{ messageId: 'methodDestructure', data: { name: 'handle429' } },
				{ messageId: 'methodDestructure', data: { name: 'handle50X' } },
				{ messageId: 'methodDestructure', data: { name: 'observe' } },
				{ messageId: 'methodDestructure', data: { name: 'parseError' } },
				{ messageId: 'methodDestructure', data: { name: 'parseRequest' } },
				{ messageId: 'methodDestructure', data: { name: 'parseValidationError' } },
				{ messageId: 'methodDestructure', data: { name: 'postMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'randomUUID' } },
				{ messageId: 'methodDestructure', data: { name: 'request' } },
				{ messageId: 'methodDestructure', data: { name: 'routefy' } },
				{ messageId: 'methodDestructure', data: { name: 'sendMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'setRatelimitsBucket' } },
				{ messageId: 'methodDestructure', data: { name: 'setResetBucket' } },
			],
		},
		{
			name: 'ApplicationCommandInteraction: detached methods',
			filename,
			code: `import { ApplicationCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof ApplicationCommandInteraction>;
const { deferReply: _v0 } = value;
const { deleteMessage: _v1 } = value;
const { deleteResponse: _v2 } = value;
const { editMessage: _v3 } = value;
const { editOrReply: _v4 } = value;
const { editResponse: _v5 } = value;
const { fetchGuild: _v6 } = value;
const { fetchMessage: _v7 } = value;
const { fetchResponse: _v8 } = value;
const { followup: _v9 } = value;
const { hasRepliedOrAwaitPendingReply: _v10 } = value;
const { isAutocomplete: _v11 } = value;
const { isButton: _v12 } = value;
const { isChannelSelectMenu: _v13 } = value;
const { isChatInput: _v14 } = value;
const { isEntryPoint: _v15 } = value;
const { isMentionableSelectMenu: _v16 } = value;
const { isMessage: _v17 } = value;
const { isModal: _v18 } = value;
const { isRoleSelectMenu: _v19 } = value;
const { isStringSelectMenu: _v20 } = value;
const { isUser: _v21 } = value;
const { isUserSelectMenu: _v22 } = value;
const { modal: _v23 } = value;
const { reply: _v24 } = value;
const { respond: _v25 } = value;
const { write: _v26 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'hasRepliedOrAwaitPendingReply' } },
				{ messageId: 'methodDestructure', data: { name: 'isAutocomplete' } },
				{ messageId: 'methodDestructure', data: { name: 'isButton' } },
				{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isChatInput' } },
				{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } },
				{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'isModal' } },
				{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isUser' } },
				{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'reply' } },
				{ messageId: 'methodDestructure', data: { name: 'respond' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'ApplicationEmoji: detached methods',
			filename,
			code: `import { ApplicationEmoji } from 'seyfert';
declare const value: InstanceType<typeof ApplicationEmoji>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { toJSON: _v3 } = value;
const { toString: _v4 } = value;
const { url: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
				{ messageId: 'methodDestructure', data: { name: 'url' } },
			],
		},
		{
			name: 'Attachment: detached methods',
			filename,
			code: `import { Attachment } from 'seyfert';
declare const value: InstanceType<typeof Attachment>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'AttachmentBuilder: detached methods',
			filename,
			code: `import { AttachmentBuilder } from 'seyfert';
declare const value: InstanceType<typeof AttachmentBuilder>;
const { setDescription: _v0 } = value;
const { setFile: _v1 } = value;
const { setName: _v2 } = value;
const { setSpoiler: _v3 } = value;
const { toJSON: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setFile' } },
				{ messageId: 'methodDestructure', data: { name: 'setName' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'AutocompleteInteraction: detached methods',
			filename,
			code: `import { AutocompleteInteraction } from 'seyfert';
declare const value: InstanceType<typeof AutocompleteInteraction>;
const { getInput: _v0 } = value;
const { isAutocomplete: _v1 } = value;
const { reply: _v2 } = value;
const { respond: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'getInput' } },
				{ messageId: 'methodDestructure', data: { name: 'isAutocomplete' } },
				{ messageId: 'methodDestructure', data: { name: 'reply' } },
				{ messageId: 'methodDestructure', data: { name: 'respond' } },
			],
		},
		{
			name: 'AutoModerationRule: detached methods',
			filename,
			code: `import { AutoModerationRule } from 'seyfert';
declare const value: InstanceType<typeof AutoModerationRule>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { fetchCreator: _v3 } = value;
const { guild: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchCreator' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
			],
		},
		{
			name: 'BaseChannel: detached methods',
			filename,
			code: `import { BaseChannel } from 'seyfert';
declare const value: InstanceType<typeof BaseChannel>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { is: _v3 } = value;
const { isCategory: _v4 } = value;
const { isDirectory: _v5 } = value;
const { isDM: _v6 } = value;
const { isForum: _v7 } = value;
const { isGuild: _v8 } = value;
const { isGuildTextable: _v9 } = value;
const { isMedia: _v10 } = value;
const { isNamed: _v11 } = value;
const { isNews: _v12 } = value;
const { isStage: _v13 } = value;
const { isTextable: _v14 } = value;
const { isTextGuild: _v15 } = value;
const { isThread: _v16 } = value;
const { isThreadOnly: _v17 } = value;
const { isVoice: _v18 } = value;
const { toString: _v19 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'is' } },
				{ messageId: 'methodDestructure', data: { name: 'isCategory' } },
				{ messageId: 'methodDestructure', data: { name: 'isDirectory' } },
				{ messageId: 'methodDestructure', data: { name: 'isDM' } },
				{ messageId: 'methodDestructure', data: { name: 'isForum' } },
				{ messageId: 'methodDestructure', data: { name: 'isGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isGuildTextable' } },
				{ messageId: 'methodDestructure', data: { name: 'isMedia' } },
				{ messageId: 'methodDestructure', data: { name: 'isNamed' } },
				{ messageId: 'methodDestructure', data: { name: 'isNews' } },
				{ messageId: 'methodDestructure', data: { name: 'isStage' } },
				{ messageId: 'methodDestructure', data: { name: 'isTextable' } },
				{ messageId: 'methodDestructure', data: { name: 'isTextGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isThread' } },
				{ messageId: 'methodDestructure', data: { name: 'isThreadOnly' } },
				{ messageId: 'methodDestructure', data: { name: 'isVoice' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
			],
		},
		{
			name: 'BaseCommand: detached methods',
			filename,
			code: `import { BaseCommand } from 'seyfert';
declare const value: InstanceType<typeof BaseCommand>;
const { onAfterRun: _v0 } = value;
const { onBeforeMiddlewares: _v1 } = value;
const { onBeforeOptions: _v2 } = value;
const { onBotPermissionsFail: _v3 } = value;
const { onInternalError: _v4 } = value;
const { onMiddlewaresError: _v5 } = value;
const { onOptionsError: _v6 } = value;
const { onPermissionsFail: _v7 } = value;
const { onRunError: _v8 } = value;
const { reload: _v9 } = value;
const { run: _v10 } = value;
const { toJSON: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } },
				{ messageId: 'methodDestructure', data: { name: 'onInternalError' } },
				{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } },
				{ messageId: 'methodDestructure', data: { name: 'onOptionsError' } },
				{ messageId: 'methodDestructure', data: { name: 'onPermissionsFail' } },
				{ messageId: 'methodDestructure', data: { name: 'onRunError' } },
				{ messageId: 'methodDestructure', data: { name: 'reload' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'BaseComponentBuilder: detached methods',
			filename,
			code: `import { BaseComponentBuilder } from 'seyfert';
declare const value: InstanceType<typeof BaseComponentBuilder>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'BaseGuildChannel: detached methods',
			filename,
			code: `import { BaseGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof BaseGuildChannel>;
const { guild: _v0 } = value;
const { memberPermissions: _v1 } = value;
const { overwritesFor: _v2 } = value;
const { rolePermissions: _v3 } = value;
const { setName: _v4 } = value;
const { setNsfw: _v5 } = value;
const { setParent: _v6 } = value;
const { setPosition: _v7 } = value;
const { setRatelimitPerUser: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'memberPermissions' } },
				{ messageId: 'methodDestructure', data: { name: 'overwritesFor' } },
				{ messageId: 'methodDestructure', data: { name: 'rolePermissions' } },
				{ messageId: 'methodDestructure', data: { name: 'setName' } },
				{ messageId: 'methodDestructure', data: { name: 'setNsfw' } },
				{ messageId: 'methodDestructure', data: { name: 'setParent' } },
				{ messageId: 'methodDestructure', data: { name: 'setPosition' } },
				{ messageId: 'methodDestructure', data: { name: 'setRatelimitPerUser' } },
			],
		},
		{
			name: 'BaseGuildMember: detached methods',
			filename,
			code: `import { BaseGuildMember } from 'seyfert';
declare const value: InstanceType<typeof BaseGuildMember>;
const { ban: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;
const { kick: _v4 } = value;
const { presence: _v5 } = value;
const { timeout: _v6 } = value;
const { toString: _v7 } = value;
const { voice: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'ban' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'kick' } },
				{ messageId: 'methodDestructure', data: { name: 'presence' } },
				{ messageId: 'methodDestructure', data: { name: 'timeout' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
				{ messageId: 'methodDestructure', data: { name: 'voice' } },
			],
		},
		{
			name: 'BaseInteraction: detached methods',
			filename,
			code: `import { BaseInteraction } from 'seyfert';
declare const value: InstanceType<typeof BaseInteraction>;
const { deferReply: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			name: 'BaseMessage: detached methods',
			filename,
			code: `import { BaseMessage } from 'seyfert';
declare const value: InstanceType<typeof BaseMessage>;
const { channel: _v0 } = value;
const { createComponentCollector: _v1 } = value;
const { guild: _v2 } = value;
const { react: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'createComponentCollector' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'react' } },
			],
		},
		{
			name: 'BaseNoEditableChannel: detached methods',
			filename,
			code: `import { BaseNoEditableChannel } from 'seyfert';
declare const value: InstanceType<typeof BaseNoEditableChannel>;
const { fetch: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			name: 'BaseResource: detached methods',
			filename,
			code: `import { BaseResource } from 'seyfert';
declare const value: InstanceType<typeof BaseResource>;
const { addToRelationship: _v0 } = value;
const { bulk: _v1 } = value;
const { contains: _v2 } = value;
const { count: _v3 } = value;
const { filter: _v4 } = value;
const { flush: _v5 } = value;
const { get: _v6 } = value;
const { getToRelationship: _v7 } = value;
const { hashId: _v8 } = value;
const { keys: _v9 } = value;
const { patch: _v10 } = value;
const { remove: _v11 } = value;
const { removeIfNI: _v12 } = value;
const { removeToRelationship: _v13 } = value;
const { set: _v14 } = value;
const { setIfNI: _v15 } = value;
const { values: _v16 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulk' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'hashId' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'setIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'Button: detached methods',
			filename,
			code: `import { Button } from 'seyfert';
declare const value: InstanceType<typeof Button>;
const { setCustomId: _v0 } = value;
const { setDisabled: _v1 } = value;
const { setEmoji: _v2 } = value;
const { setLabel: _v3 } = value;
const { setSKUId: _v4 } = value;
const { setStyle: _v5 } = value;
const { setURL: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setDisabled' } },
				{ messageId: 'methodDestructure', data: { name: 'setEmoji' } },
				{ messageId: 'methodDestructure', data: { name: 'setLabel' } },
				{ messageId: 'methodDestructure', data: { name: 'setSKUId' } },
				{ messageId: 'methodDestructure', data: { name: 'setStyle' } },
				{ messageId: 'methodDestructure', data: { name: 'setURL' } },
			],
		},
		{
			name: 'ButtonInteraction: detached methods',
			filename,
			code: `import { ButtonInteraction } from 'seyfert';
declare const value: InstanceType<typeof ButtonInteraction>;
const { deferUpdate: _v0 } = value;
const { isButton: _v1 } = value;
const { update: _v2 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } },
				{ messageId: 'methodDestructure', data: { name: 'isButton' } },
				{ messageId: 'methodDestructure', data: { name: 'update' } },
			],
		},
		{
			name: 'Cache: detached methods',
			filename,
			code: `import { Cache } from 'seyfert';
declare const value: InstanceType<typeof Cache>;
const { buildCache: _v0 } = value;
const { bulkGet: _v1 } = value;
const { bulkPatch: _v2 } = value;
const { bulkSet: _v3 } = value;
const { flush: _v4 } = value;
const { hasIntent: _v5 } = value;
const { onPacket: _v6 } = value;
const { onPacketDefault: _v7 } = value;
const { testAdapter: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'buildCache' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkGet' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkSet' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'hasIntent' } },
				{ messageId: 'methodDestructure', data: { name: 'onPacket' } },
				{ messageId: 'methodDestructure', data: { name: 'onPacketDefault' } },
				{ messageId: 'methodDestructure', data: { name: 'testAdapter' } },
			],
		},
		{
			name: 'CategoryChannel: detached methods',
			filename,
			code: `import { CategoryChannel } from 'seyfert';
declare const value: InstanceType<typeof CategoryChannel>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'ChannelSelectMenu: detached methods',
			filename,
			code: `import { ChannelSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof ChannelSelectMenu>;
const { addDefaultChannels: _v0 } = value;
const { setChannelTypes: _v1 } = value;
const { setCustomId: _v2 } = value;
const { setDefaultChannels: _v3 } = value;
const { setDisabled: _v4 } = value;
const { setPlaceholder: _v5 } = value;
const { setRequired: _v6 } = value;
const { setValuesLength: _v7 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addDefaultChannels' } },
				{ messageId: 'methodDestructure', data: { name: 'setChannelTypes' } },
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setDefaultChannels' } },
				{ messageId: 'methodDestructure', data: { name: 'setDisabled' } },
				{ messageId: 'methodDestructure', data: { name: 'setPlaceholder' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
				{ messageId: 'methodDestructure', data: { name: 'setValuesLength' } },
			],
		},
		{
			name: 'ChannelSelectMenuInteraction: detached methods',
			filename,
			code: `import { ChannelSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof ChannelSelectMenuInteraction>;
const { isChannelSelectMenu: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } }],
		},
		{
			name: 'ChatInputCommandInteraction: detached methods',
			filename,
			code: `import { ChatInputCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof ChatInputCommandInteraction>;
const { isChatInput: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isChatInput' } }],
		},
		{
			name: 'Checkbox: detached methods',
			filename,
			code: `import { Checkbox } from 'seyfert';
declare const value: InstanceType<typeof Checkbox>;
const { setCustomId: _v0 } = value;
const { setDefault: _v1 } = value;
const { setId: _v2 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setDefault' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
			],
		},
		{
			name: 'CheckboxGroup: detached methods',
			filename,
			code: `import { CheckboxGroup } from 'seyfert';
declare const value: InstanceType<typeof CheckboxGroup>;
const { addOptions: _v0 } = value;
const { setCustomId: _v1 } = value;
const { setId: _v2 } = value;
const { setOptions: _v3 } = value;
const { setRequired: _v4 } = value;
const { setSelectionLimit: _v5 } = value;
const { toJSON: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
				{ messageId: 'methodDestructure', data: { name: 'setSelectionLimit' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'CheckboxGroupOption: detached methods',
			filename,
			code: `import { CheckboxGroupOption } from 'seyfert';
declare const value: InstanceType<typeof CheckboxGroupOption>;
const { setDefault: _v0 } = value;
const { setDescription: _v1 } = value;
const { setLabel: _v2 } = value;
const { setValue: _v3 } = value;
const { toJSON: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDefault' } },
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setLabel' } },
				{ messageId: 'methodDestructure', data: { name: 'setValue' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'ClientUser: detached methods',
			filename,
			code: `import { ClientUser } from 'seyfert';
declare const value: InstanceType<typeof ClientUser>;
const { avatarDecorationURL: _v0 } = value;
const { avatarURL: _v1 } = value;
const { bannerURL: _v2 } = value;
const { defaultAvatarURL: _v3 } = value;
const { dm: _v4 } = value;
const { edit: _v5 } = value;
const { fetch: _v6 } = value;
const { presence: _v7 } = value;
const { toString: _v8 } = value;
const { write: _v9 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'avatarDecorationURL' } },
				{ messageId: 'methodDestructure', data: { name: 'avatarURL' } },
				{ messageId: 'methodDestructure', data: { name: 'bannerURL' } },
				{ messageId: 'methodDestructure', data: { name: 'defaultAvatarURL' } },
				{ messageId: 'methodDestructure', data: { name: 'dm' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'presence' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'Collection: detached methods',
			filename,
			code: `import { Collection } from 'seyfert';
declare const value: InstanceType<typeof Collection>;
const { every: _v0 } = value;
const { filter: _v1 } = value;
const { filterCollection: _v2 } = value;
const { find: _v3 } = value;
const { findKey: _v4 } = value;
const { map: _v5 } = value;
const { reduce: _v6 } = value;
const { some: _v7 } = value;
const { sweep: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'every' } },
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'filterCollection' } },
				{ messageId: 'methodDestructure', data: { name: 'find' } },
				{ messageId: 'methodDestructure', data: { name: 'findKey' } },
				{ messageId: 'methodDestructure', data: { name: 'map' } },
				{ messageId: 'methodDestructure', data: { name: 'reduce' } },
				{ messageId: 'methodDestructure', data: { name: 'some' } },
				{ messageId: 'methodDestructure', data: { name: 'sweep' } },
			],
		},
		{
			name: 'Collectors: detached methods',
			filename,
			code: `import { Collectors } from 'seyfert';
declare const value: InstanceType<typeof Collectors>;
const { create: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'create' } }],
		},
		{
			name: 'Command: detached methods',
			filename,
			code: `import { Command } from 'seyfert';
declare const value: InstanceType<typeof Command>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'CommandContext: detached methods',
			filename,
			code: `import { CommandContext } from 'seyfert';
declare const value: InstanceType<typeof CommandContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deleteResponse: _v2 } = value;
const { editOrReply: _v3 } = value;
const { editResponse: _v4 } = value;
const { fetchMember: _v5 } = value;
const { fetchResponse: _v6 } = value;
const { followup: _v7 } = value;
const { guild: _v8 } = value;
const { inGuild: _v9 } = value;
const { isButton: _v10 } = value;
const { isChannelSelectMenu: _v11 } = value;
const { isChat: _v12 } = value;
const { isComponent: _v13 } = value;
const { isEntryPoint: _v14 } = value;
const { isMentionableSelectMenu: _v15 } = value;
const { isMenu: _v16 } = value;
const { isMenuMessage: _v17 } = value;
const { isMenuUser: _v18 } = value;
const { isModal: _v19 } = value;
const { isRoleSelectMenu: _v20 } = value;
const { isStringSelectMenu: _v21 } = value;
const { isUserSelectMenu: _v22 } = value;
const { me: _v23 } = value;
const { modal: _v24 } = value;
const { write: _v25 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchMember' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isButton' } },
				{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isChat' } },
				{ messageId: 'methodDestructure', data: { name: 'isComponent' } },
				{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } },
				{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenuMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenuUser' } },
				{ messageId: 'methodDestructure', data: { name: 'isModal' } },
				{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'ComponentCommand: detached methods',
			filename,
			code: `import { ComponentCommand } from 'seyfert';
declare const value: InstanceType<typeof ComponentCommand>;
const { filter: _v0 } = value;
const { onAfterRun: _v1 } = value;
const { onBeforeMiddlewares: _v2 } = value;
const { onInternalError: _v3 } = value;
const { onMiddlewaresError: _v4 } = value;
const { onRunError: _v5 } = value;
const { run: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } },
				{ messageId: 'methodDestructure', data: { name: 'onInternalError' } },
				{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } },
				{ messageId: 'methodDestructure', data: { name: 'onRunError' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
			],
		},
		{
			name: 'ComponentContext: detached methods',
			filename,
			code: `import { ComponentContext } from 'seyfert';
declare const value: InstanceType<typeof ComponentContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deferUpdate: _v2 } = value;
const { deleteResponse: _v3 } = value;
const { editOrReply: _v4 } = value;
const { fetchResponse: _v5 } = value;
const { followup: _v6 } = value;
const { guild: _v7 } = value;
const { inGuild: _v8 } = value;
const { isButton: _v9 } = value;
const { isChannelSelectMenu: _v10 } = value;
const { isChat: _v11 } = value;
const { isComponent: _v12 } = value;
const { isMentionableSelectMenu: _v13 } = value;
const { isRoleSelectMenu: _v14 } = value;
const { isStringSelectMenu: _v15 } = value;
const { isUserSelectMenu: _v16 } = value;
const { me: _v17 } = value;
const { modal: _v18 } = value;
const { update: _v19 } = value;
const { write: _v20 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isButton' } },
				{ messageId: 'methodDestructure', data: { name: 'isChannelSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isChat' } },
				{ messageId: 'methodDestructure', data: { name: 'isComponent' } },
				{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'update' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'ComponentInteraction: detached methods',
			filename,
			code: `import { ComponentInteraction } from 'seyfert';
declare const value: InstanceType<typeof ComponentInteraction>;
const { deferReply: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			name: 'Container: detached methods',
			filename,
			code: `import { Container } from 'seyfert';
declare const value: InstanceType<typeof Container>;
const { addComponents: _v0 } = value;
const { setColor: _v1 } = value;
const { setComponents: _v2 } = value;
const { setId: _v3 } = value;
const { setSpoiler: _v4 } = value;
const { toJSON: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'setColor' } },
				{ messageId: 'methodDestructure', data: { name: 'setComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'ContextMenuCommand: detached methods',
			filename,
			code: `import { ContextMenuCommand } from 'seyfert';
declare const value: InstanceType<typeof ContextMenuCommand>;
const { onAfterRun: _v0 } = value;
const { onBeforeMiddlewares: _v1 } = value;
const { onBotPermissionsFail: _v2 } = value;
const { onInternalError: _v3 } = value;
const { onMiddlewaresError: _v4 } = value;
const { onRunError: _v5 } = value;
const { reload: _v6 } = value;
const { run: _v7 } = value;
const { toJSON: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } },
				{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } },
				{ messageId: 'methodDestructure', data: { name: 'onInternalError' } },
				{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } },
				{ messageId: 'methodDestructure', data: { name: 'onRunError' } },
				{ messageId: 'methodDestructure', data: { name: 'reload' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'CustomEventHandler: detached methods',
			filename,
			code: `import { CustomEventHandler } from 'seyfert';
declare const value: InstanceType<typeof CustomEventHandler>;
const { createPluginListenerTask: _v0 } = value;
const { emit: _v1 } = value;
const { getFiles: _v2 } = value;
const { getPluginAnyListeners: _v3 } = value;
const { getPluginErrorListeners: _v4 } = value;
const { getPluginListeners: _v5 } = value;
const { loadFiles: _v6 } = value;
const { loadFilesK: _v7 } = value;
const { reportEventFailure: _v8 } = value;
const { runCollectors: _v9 } = value;
const { runCustom: _v10 } = value;
const { settleEventTasks: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'createPluginListenerTask' } },
				{ messageId: 'methodDestructure', data: { name: 'emit' } },
				{ messageId: 'methodDestructure', data: { name: 'getFiles' } },
				{ messageId: 'methodDestructure', data: { name: 'getPluginAnyListeners' } },
				{ messageId: 'methodDestructure', data: { name: 'getPluginErrorListeners' } },
				{ messageId: 'methodDestructure', data: { name: 'getPluginListeners' } },
				{ messageId: 'methodDestructure', data: { name: 'loadFiles' } },
				{ messageId: 'methodDestructure', data: { name: 'loadFilesK' } },
				{ messageId: 'methodDestructure', data: { name: 'reportEventFailure' } },
				{ messageId: 'methodDestructure', data: { name: 'runCollectors' } },
				{ messageId: 'methodDestructure', data: { name: 'runCustom' } },
				{ messageId: 'methodDestructure', data: { name: 'settleEventTasks' } },
			],
		},
		{
			name: 'DirectoryChannel: detached methods',
			filename,
			code: `import { DirectoryChannel } from 'seyfert';
declare const value: InstanceType<typeof DirectoryChannel>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'DMChannel: detached methods',
			filename,
			code: `import { DMChannel } from 'seyfert';
declare const value: InstanceType<typeof DMChannel>;
const { typing: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			name: 'Embed: detached methods',
			filename,
			code: `import { Embed } from 'seyfert';
declare const value: InstanceType<typeof Embed>;
const { addFields: _v0 } = value;
const { setAuthor: _v1 } = value;
const { setColor: _v2 } = value;
const { setDescription: _v3 } = value;
const { setFields: _v4 } = value;
const { setFooter: _v5 } = value;
const { setImage: _v6 } = value;
const { setThumbnail: _v7 } = value;
const { setTimestamp: _v8 } = value;
const { setTitle: _v9 } = value;
const { setURL: _v10 } = value;
const { toJSON: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addFields' } },
				{ messageId: 'methodDestructure', data: { name: 'setAuthor' } },
				{ messageId: 'methodDestructure', data: { name: 'setColor' } },
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setFields' } },
				{ messageId: 'methodDestructure', data: { name: 'setFooter' } },
				{ messageId: 'methodDestructure', data: { name: 'setImage' } },
				{ messageId: 'methodDestructure', data: { name: 'setThumbnail' } },
				{ messageId: 'methodDestructure', data: { name: 'setTimestamp' } },
				{ messageId: 'methodDestructure', data: { name: 'setTitle' } },
				{ messageId: 'methodDestructure', data: { name: 'setURL' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'Emoji: detached methods',
			filename,
			code: `import { Emoji } from 'seyfert';
declare const value: InstanceType<typeof Emoji>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'Entitlement: detached methods',
			filename,
			code: `import { Entitlement } from 'seyfert';
declare const value: InstanceType<typeof Entitlement>;
const { consume: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'consume' } }],
		},
		{
			name: 'EntryPointCommand: detached methods',
			filename,
			code: `import { EntryPointCommand } from 'seyfert';
declare const value: InstanceType<typeof EntryPointCommand>;
const { onAfterRun: _v0 } = value;
const { onBeforeMiddlewares: _v1 } = value;
const { onBotPermissionsFail: _v2 } = value;
const { onInternalError: _v3 } = value;
const { onMiddlewaresError: _v4 } = value;
const { onRunError: _v5 } = value;
const { reload: _v6 } = value;
const { run: _v7 } = value;
const { toJSON: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } },
				{ messageId: 'methodDestructure', data: { name: 'onBotPermissionsFail' } },
				{ messageId: 'methodDestructure', data: { name: 'onInternalError' } },
				{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } },
				{ messageId: 'methodDestructure', data: { name: 'onRunError' } },
				{ messageId: 'methodDestructure', data: { name: 'reload' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'EntryPointContext: detached methods',
			filename,
			code: `import { EntryPointContext } from 'seyfert';
declare const value: InstanceType<typeof EntryPointContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deleteResponse: _v2 } = value;
const { editOrReply: _v3 } = value;
const { editResponse: _v4 } = value;
const { fetchResponse: _v5 } = value;
const { followup: _v6 } = value;
const { guild: _v7 } = value;
const { inGuild: _v8 } = value;
const { isEntryPoint: _v9 } = value;
const { me: _v10 } = value;
const { modal: _v11 } = value;
const { write: _v12 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'EntryPointInteraction: detached methods',
			filename,
			code: `import { EntryPointInteraction } from 'seyfert';
declare const value: InstanceType<typeof EntryPointInteraction>;
const { isEntryPoint: _v0 } = value;
const { withResponse: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'isEntryPoint' } },
				{ messageId: 'methodDestructure', data: { name: 'withResponse' } },
			],
		},
		{
			name: 'EventHandler: detached methods',
			filename,
			code: `import { EventHandler } from 'seyfert';
declare const value: InstanceType<typeof EventHandler>;
const { execute: _v0 } = value;
const { load: _v1 } = value;
const { onFile: _v2 } = value;
const { reload: _v3 } = value;
const { reloadAll: _v4 } = value;
const { runEvent: _v5 } = value;
const { set: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'execute' } },
				{ messageId: 'methodDestructure', data: { name: 'load' } },
				{ messageId: 'methodDestructure', data: { name: 'onFile' } },
				{ messageId: 'methodDestructure', data: { name: 'reload' } },
				{ messageId: 'methodDestructure', data: { name: 'reloadAll' } },
				{ messageId: 'methodDestructure', data: { name: 'runEvent' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
			],
		},
		{
			name: 'File: detached methods',
			filename,
			code: `import { File } from 'seyfert';
declare const value: InstanceType<typeof File>;
const { setId: _v0 } = value;
const { setMedia: _v1 } = value;
const { setSpoiler: _v2 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setMedia' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } },
			],
		},
		{
			name: 'FileUpload: detached methods',
			filename,
			code: `import { FileUpload } from 'seyfert';
declare const value: InstanceType<typeof FileUpload>;
const { setCustomId: _v0 } = value;
const { setId: _v1 } = value;
const { setMaxValues: _v2 } = value;
const { setMinValues: _v3 } = value;
const { setRequired: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setMaxValues' } },
				{ messageId: 'methodDestructure', data: { name: 'setMinValues' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
			],
		},
		{
			name: 'ForumChannel: detached methods',
			filename,
			code: `import { ForumChannel } from 'seyfert';
declare const value: InstanceType<typeof ForumChannel>;
const { setAutoArchiveDuration: _v0 } = value;
const { setReactionEmoji: _v1 } = value;
const { setSortOrder: _v2 } = value;
const { setTags: _v3 } = value;
const { setThreadRateLimit: _v4 } = value;
const { setTopic: _v5 } = value;
const { thread: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setAutoArchiveDuration' } },
				{ messageId: 'methodDestructure', data: { name: 'setReactionEmoji' } },
				{ messageId: 'methodDestructure', data: { name: 'setSortOrder' } },
				{ messageId: 'methodDestructure', data: { name: 'setTags' } },
				{ messageId: 'methodDestructure', data: { name: 'setThreadRateLimit' } },
				{ messageId: 'methodDestructure', data: { name: 'setTopic' } },
				{ messageId: 'methodDestructure', data: { name: 'thread' } },
			],
		},
		{
			name: 'Guild: detached methods',
			filename,
			code: `import { Guild } from 'seyfert';
declare const value: InstanceType<typeof Guild>;
const { edit: _v0 } = value;
const { fetchOwner: _v1 } = value;
const { listActiveThreads: _v2 } = value;
const { searchMessages: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchOwner' } },
				{ messageId: 'methodDestructure', data: { name: 'listActiveThreads' } },
				{ messageId: 'methodDestructure', data: { name: 'searchMessages' } },
			],
		},
		{
			name: 'GuildBan: detached methods',
			filename,
			code: `import { GuildBan } from 'seyfert';
declare const value: InstanceType<typeof GuildBan>;
const { create: _v0 } = value;
const { fetch: _v1 } = value;
const { guild: _v2 } = value;
const { remove: _v3 } = value;
const { toString: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'create' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
			],
		},
		{
			name: 'GuildBasedResource: detached methods',
			filename,
			code: `import { GuildBasedResource } from 'seyfert';
declare const value: InstanceType<typeof GuildBasedResource>;
const { addToRelationship: _v0 } = value;
const { bulk: _v1 } = value;
const { contains: _v2 } = value;
const { count: _v3 } = value;
const { filter: _v4 } = value;
const { flush: _v5 } = value;
const { get: _v6 } = value;
const { getToRelationship: _v7 } = value;
const { hashGuildId: _v8 } = value;
const { hashId: _v9 } = value;
const { keys: _v10 } = value;
const { parse: _v11 } = value;
const { patch: _v12 } = value;
const { remove: _v13 } = value;
const { removeIfNI: _v14 } = value;
const { removeRelationship: _v15 } = value;
const { removeToRelationship: _v16 } = value;
const { set: _v17 } = value;
const { setIfNI: _v18 } = value;
const { values: _v19 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulk' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'hashGuildId' } },
				{ messageId: 'methodDestructure', data: { name: 'hashId' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'parse' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'setIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'GuildEmoji: detached methods',
			filename,
			code: `import { GuildEmoji } from 'seyfert';
declare const value: InstanceType<typeof GuildEmoji>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
			],
		},
		{
			name: 'GuildMember: detached methods',
			filename,
			code: `import { GuildMember } from 'seyfert';
declare const value: InstanceType<typeof GuildMember>;
const { avatarURL: _v0 } = value;
const { bannable: _v1 } = value;
const { bannerURL: _v2 } = value;
const { defaultAvatarURL: _v3 } = value;
const { dm: _v4 } = value;
const { fetchPermissions: _v5 } = value;
const { kickable: _v6 } = value;
const { manageable: _v7 } = value;
const { moderatable: _v8 } = value;
const { write: _v9 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'avatarURL' } },
				{ messageId: 'methodDestructure', data: { name: 'bannable' } },
				{ messageId: 'methodDestructure', data: { name: 'bannerURL' } },
				{ messageId: 'methodDestructure', data: { name: 'defaultAvatarURL' } },
				{ messageId: 'methodDestructure', data: { name: 'dm' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchPermissions' } },
				{ messageId: 'methodDestructure', data: { name: 'kickable' } },
				{ messageId: 'methodDestructure', data: { name: 'manageable' } },
				{ messageId: 'methodDestructure', data: { name: 'moderatable' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'GuildPreview: detached methods',
			filename,
			code: `import { GuildPreview } from 'seyfert';
declare const value: InstanceType<typeof GuildPreview>;
const { fetch: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			name: 'GuildRelatedResource: detached methods',
			filename,
			code: `import { GuildRelatedResource } from 'seyfert';
declare const value: InstanceType<typeof GuildRelatedResource>;
const { addToRelationship: _v0 } = value;
const { bulk: _v1 } = value;
const { contains: _v2 } = value;
const { count: _v3 } = value;
const { filter: _v4 } = value;
const { flush: _v5 } = value;
const { get: _v6 } = value;
const { getToRelationship: _v7 } = value;
const { hashId: _v8 } = value;
const { keys: _v9 } = value;
const { parse: _v10 } = value;
const { patch: _v11 } = value;
const { remove: _v12 } = value;
const { removeIfNI: _v13 } = value;
const { removeRelationship: _v14 } = value;
const { removeToRelationship: _v15 } = value;
const { set: _v16 } = value;
const { setIfNI: _v17 } = value;
const { values: _v18 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulk' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'hashId' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'parse' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'setIfNI' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'GuildRole: detached methods',
			filename,
			code: `import { GuildRole } from 'seyfert';
declare const value: InstanceType<typeof GuildRole>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;
const { toString: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'toString' } },
			],
		},
		{
			name: 'GuildTemplate: detached methods',
			filename,
			code: `import { GuildTemplate } from 'seyfert';
declare const value: InstanceType<typeof GuildTemplate>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;
const { sync: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'sync' } },
			],
		},
		{
			name: 'HttpClient: detached methods',
			filename,
			code: `import { HttpClient } from 'seyfert';
declare const value: InstanceType<typeof HttpClient>;
const { close: _v0 } = value;
const { configureLogger: _v1 } = value;
const { execute: _v2 } = value;
const { getRC: _v3 } = value;
const { loadCommands: _v4 } = value;
const { loadComponents: _v5 } = value;
const { loadLangs: _v6 } = value;
const { onInteractionRequest: _v7 } = value;
const { onPacket: _v8 } = value;
const { reloadPluginContributions: _v9 } = value;
const { resolvePluginGatewayIntents: _v10 } = value;
const { setServices: _v11 } = value;
const { start: _v12 } = value;
const { t: _v13 } = value;
const { uploadCommands: _v14 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'close' } },
				{ messageId: 'methodDestructure', data: { name: 'configureLogger' } },
				{ messageId: 'methodDestructure', data: { name: 'execute' } },
				{ messageId: 'methodDestructure', data: { name: 'getRC' } },
				{ messageId: 'methodDestructure', data: { name: 'loadCommands' } },
				{ messageId: 'methodDestructure', data: { name: 'loadComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'loadLangs' } },
				{ messageId: 'methodDestructure', data: { name: 'onInteractionRequest' } },
				{ messageId: 'methodDestructure', data: { name: 'onPacket' } },
				{ messageId: 'methodDestructure', data: { name: 'reloadPluginContributions' } },
				{ messageId: 'methodDestructure', data: { name: 'resolvePluginGatewayIntents' } },
				{ messageId: 'methodDestructure', data: { name: 'setServices' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 't' } },
				{ messageId: 'methodDestructure', data: { name: 'uploadCommands' } },
			],
		},
		{
			name: 'InMessageEmbed: detached methods',
			filename,
			code: `import { InMessageEmbed } from 'seyfert';
declare const value: InstanceType<typeof InMessageEmbed>;
const { toBuilder: _v0 } = value;
const { toJSON: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'toBuilder' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'Interaction: detached methods',
			filename,
			code: `import { Interaction } from 'seyfert';
declare const value: InstanceType<typeof Interaction>;
const { deferReply: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			name: 'InteractionGuildMember: detached methods',
			filename,
			code: `import { InteractionGuildMember } from 'seyfert';
declare const value: InstanceType<typeof InteractionGuildMember>;
const { avatarURL: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'avatarURL' } }],
		},
		{
			name: 'InteractionResponseContext: detached methods',
			filename,
			code: `import { InteractionResponseContext } from 'seyfert';
declare const value: InstanceType<typeof InteractionResponseContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deleteResponse: _v2 } = value;
const { editOrReply: _v3 } = value;
const { editResponse: _v4 } = value;
const { fetchResponse: _v5 } = value;
const { followup: _v6 } = value;
const { guild: _v7 } = value;
const { inGuild: _v8 } = value;
const { me: _v9 } = value;
const { modal: _v10 } = value;
const { write: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'Label: detached methods',
			filename,
			code: `import { Label } from 'seyfert';
declare const value: InstanceType<typeof Label>;
const { setComponent: _v0 } = value;
const { setDescription: _v1 } = value;
const { setLabel: _v2 } = value;
const { toJSON: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setComponent' } },
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setLabel' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'LangsHandler: detached methods',
			filename,
			code: `import { LangsHandler } from 'seyfert';
declare const value: InstanceType<typeof LangsHandler>;
const { get: _v0 } = value;
const { getKey: _v1 } = value;
const { getLocale: _v2 } = value;
const { load: _v3 } = value;
const { onFile: _v4 } = value;
const { parse: _v5 } = value;
const { reload: _v6 } = value;
const { reloadAll: _v7 } = value;
const { set: _v8 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getKey' } },
				{ messageId: 'methodDestructure', data: { name: 'getLocale' } },
				{ messageId: 'methodDestructure', data: { name: 'load' } },
				{ messageId: 'methodDestructure', data: { name: 'onFile' } },
				{ messageId: 'methodDestructure', data: { name: 'parse' } },
				{ messageId: 'methodDestructure', data: { name: 'reload' } },
				{ messageId: 'methodDestructure', data: { name: 'reloadAll' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
			],
		},
		{
			name: 'LimitedCollection: detached methods',
			filename,
			code: `import { LimitedCollection } from 'seyfert';
declare const value: InstanceType<typeof LimitedCollection>;
const { clear: _v0 } = value;
const { delete: _v1 } = value;
const { entries: _v2 } = value;
const { get: _v3 } = value;
const { has: _v4 } = value;
const { keys: _v5 } = value;
const { raw: _v6 } = value;
const { rawEntries: _v7 } = value;
const { rawValues: _v8 } = value;
const { set: _v9 } = value;
const { values: _v10 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'clear' } },
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'entries' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'has' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'raw' } },
				{ messageId: 'methodDestructure', data: { name: 'rawEntries' } },
				{ messageId: 'methodDestructure', data: { name: 'rawValues' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'LimitedMemoryAdapter: detached methods',
			filename,
			code: `import { LimitedMemoryAdapter } from 'seyfert';
declare const value: InstanceType<typeof LimitedMemoryAdapter>;
const { addToRelationship: _v0 } = value;
const { bulkAddToRelationShip: _v1 } = value;
const { bulkGet: _v2 } = value;
const { bulkPatch: _v3 } = value;
const { bulkRemove: _v4 } = value;
const { bulkSet: _v5 } = value;
const { contains: _v6 } = value;
const { count: _v7 } = value;
const { flush: _v8 } = value;
const { get: _v9 } = value;
const { getToRelationship: _v10 } = value;
const { keys: _v11 } = value;
const { patch: _v12 } = value;
const { remove: _v13 } = value;
const { removeRelationship: _v14 } = value;
const { removeToRelationship: _v15 } = value;
const { scan: _v16 } = value;
const { set: _v17 } = value;
const { start: _v18 } = value;
const { values: _v19 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkGet' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkSet' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'scan' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'Logger: detached methods',
			filename,
			code: `import { Logger } from 'seyfert';
declare const value: InstanceType<typeof Logger>;
const { debug: _v0 } = value;
const { error: _v1 } = value;
const { fatal: _v2 } = value;
const { info: _v3 } = value;
const { rawLog: _v4 } = value;
const { warn: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'debug' } },
				{ messageId: 'methodDestructure', data: { name: 'error' } },
				{ messageId: 'methodDestructure', data: { name: 'fatal' } },
				{ messageId: 'methodDestructure', data: { name: 'info' } },
				{ messageId: 'methodDestructure', data: { name: 'rawLog' } },
				{ messageId: 'methodDestructure', data: { name: 'warn' } },
			],
		},
		{
			name: 'MediaChannel: detached methods',
			filename,
			code: `import { MediaChannel } from 'seyfert';
declare const value: InstanceType<typeof MediaChannel>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'MediaGallery: detached methods',
			filename,
			code: `import { MediaGallery } from 'seyfert';
declare const value: InstanceType<typeof MediaGallery>;
const { addItems: _v0 } = value;
const { setId: _v1 } = value;
const { setItems: _v2 } = value;
const { toJSON: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addItems' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setItems' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'MediaGalleryItem: detached methods',
			filename,
			code: `import { MediaGalleryItem } from 'seyfert';
declare const value: InstanceType<typeof MediaGalleryItem>;
const { setDescription: _v0 } = value;
const { setMedia: _v1 } = value;
const { setSpoiler: _v2 } = value;
const { toJSON: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setMedia' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'MemoryAdapter: detached methods',
			filename,
			code: `import { MemoryAdapter } from 'seyfert';
declare const value: InstanceType<typeof MemoryAdapter>;
const { addToRelationship: _v0 } = value;
const { bulkAddToRelationShip: _v1 } = value;
const { bulkGet: _v2 } = value;
const { bulkPatch: _v3 } = value;
const { bulkRemove: _v4 } = value;
const { bulkSet: _v5 } = value;
const { contains: _v6 } = value;
const { count: _v7 } = value;
const { flush: _v8 } = value;
const { get: _v9 } = value;
const { getToRelationship: _v10 } = value;
const { keys: _v11 } = value;
const { patch: _v12 } = value;
const { remove: _v13 } = value;
const { removeRelationship: _v14 } = value;
const { removeToRelationship: _v15 } = value;
const { scan: _v16 } = value;
const { set: _v17 } = value;
const { start: _v18 } = value;
const { values: _v19 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkGet' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkSet' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'scan' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'MentionableSelectMenu: detached methods',
			filename,
			code: `import { MentionableSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof MentionableSelectMenu>;
const { addDefaultMentionables: _v0 } = value;
const { setDefaultMentionables: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addDefaultMentionables' } },
				{ messageId: 'methodDestructure', data: { name: 'setDefaultMentionables' } },
			],
		},
		{
			name: 'MentionableSelectMenuInteraction: detached methods',
			filename,
			code: `import { MentionableSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof MentionableSelectMenuInteraction>;
const { isMentionableSelectMenu: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMentionableSelectMenu' } }],
		},
		{
			name: 'MenuCommandContext: detached methods',
			filename,
			code: `import { MenuCommandContext } from 'seyfert';
declare const value: InstanceType<typeof MenuCommandContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deleteResponse: _v2 } = value;
const { editOrReply: _v3 } = value;
const { editResponse: _v4 } = value;
const { fetchResponse: _v5 } = value;
const { followup: _v6 } = value;
const { guild: _v7 } = value;
const { inGuild: _v8 } = value;
const { isMenu: _v9 } = value;
const { isMenuMessage: _v10 } = value;
const { isMenuUser: _v11 } = value;
const { me: _v12 } = value;
const { modal: _v13 } = value;
const { write: _v14 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenu' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenuMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'isMenuUser' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'Message: detached methods',
			filename,
			code: `import { Message } from 'seyfert';
declare const value: InstanceType<typeof Message>;
const { crosspost: _v0 } = value;
const { delete: _v1 } = value;
const { edit: _v2 } = value;
const { endPoll: _v3 } = value;
const { fetch: _v4 } = value;
const { getAnswerVoters: _v5 } = value;
const { reply: _v6 } = value;
const { write: _v7 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'crosspost' } },
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'endPoll' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'getAnswerVoters' } },
				{ messageId: 'methodDestructure', data: { name: 'reply' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'MessageCommandInteraction: detached methods',
			filename,
			code: `import { MessageCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof MessageCommandInteraction>;
const { isMessage: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isMessage' } }],
		},
		{
			name: 'MessagesMethods: detached methods',
			filename,
			code: `import { MessagesMethods } from 'seyfert';
declare const value: InstanceType<typeof MessagesMethods>;
const { typing: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			name: 'Modal: detached methods',
			filename,
			code: `import { Modal } from 'seyfert';
declare const value: InstanceType<typeof Modal>;
const { addComponents: _v0 } = value;
const { run: _v1 } = value;
const { setComponents: _v2 } = value;
const { setCustomId: _v3 } = value;
const { setTitle: _v4 } = value;
const { toJSON: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
				{ messageId: 'methodDestructure', data: { name: 'setComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setTitle' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'ModalCommand: detached methods',
			filename,
			code: `import { ModalCommand } from 'seyfert';
declare const value: InstanceType<typeof ModalCommand>;
const { filter: _v0 } = value;
const { onAfterRun: _v1 } = value;
const { onBeforeMiddlewares: _v2 } = value;
const { onInternalError: _v3 } = value;
const { onMiddlewaresError: _v4 } = value;
const { onRunError: _v5 } = value;
const { run: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'filter' } },
				{ messageId: 'methodDestructure', data: { name: 'onAfterRun' } },
				{ messageId: 'methodDestructure', data: { name: 'onBeforeMiddlewares' } },
				{ messageId: 'methodDestructure', data: { name: 'onInternalError' } },
				{ messageId: 'methodDestructure', data: { name: 'onMiddlewaresError' } },
				{ messageId: 'methodDestructure', data: { name: 'onRunError' } },
				{ messageId: 'methodDestructure', data: { name: 'run' } },
			],
		},
		{
			name: 'ModalContext: detached methods',
			filename,
			code: `import { ModalContext } from 'seyfert';
declare const value: InstanceType<typeof ModalContext>;
const { channel: _v0 } = value;
const { deferReply: _v1 } = value;
const { deferUpdate: _v2 } = value;
const { deleteResponse: _v3 } = value;
const { editOrReply: _v4 } = value;
const { editResponse: _v5 } = value;
const { fetchResponse: _v6 } = value;
const { followup: _v7 } = value;
const { getChannels: _v8 } = value;
const { getCheckbox: _v9 } = value;
const { getCheckboxValues: _v10 } = value;
const { getFiles: _v11 } = value;
const { getInputValue: _v12 } = value;
const { getMentionables: _v13 } = value;
const { getRadioValues: _v14 } = value;
const { getRoles: _v15 } = value;
const { getUsers: _v16 } = value;
const { guild: _v17 } = value;
const { inGuild: _v18 } = value;
const { isModal: _v19 } = value;
const { me: _v20 } = value;
const { modal: _v21 } = value;
const { update: _v22 } = value;
const { write: _v23 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'deferReply' } },
				{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } },
				{ messageId: 'methodDestructure', data: { name: 'deleteResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'editOrReply' } },
				{ messageId: 'methodDestructure', data: { name: 'editResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchResponse' } },
				{ messageId: 'methodDestructure', data: { name: 'followup' } },
				{ messageId: 'methodDestructure', data: { name: 'getChannels' } },
				{ messageId: 'methodDestructure', data: { name: 'getCheckbox' } },
				{ messageId: 'methodDestructure', data: { name: 'getCheckboxValues' } },
				{ messageId: 'methodDestructure', data: { name: 'getFiles' } },
				{ messageId: 'methodDestructure', data: { name: 'getInputValue' } },
				{ messageId: 'methodDestructure', data: { name: 'getMentionables' } },
				{ messageId: 'methodDestructure', data: { name: 'getRadioValues' } },
				{ messageId: 'methodDestructure', data: { name: 'getRoles' } },
				{ messageId: 'methodDestructure', data: { name: 'getUsers' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'inGuild' } },
				{ messageId: 'methodDestructure', data: { name: 'isModal' } },
				{ messageId: 'methodDestructure', data: { name: 'me' } },
				{ messageId: 'methodDestructure', data: { name: 'modal' } },
				{ messageId: 'methodDestructure', data: { name: 'update' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'ModalSubmitInteraction: detached methods',
			filename,
			code: `import { ModalSubmitInteraction } from 'seyfert';
declare const value: InstanceType<typeof ModalSubmitInteraction>;
const { deferUpdate: _v0 } = value;
const { getChannels: _v1 } = value;
const { getCheckbox: _v2 } = value;
const { getCheckboxValues: _v3 } = value;
const { getComponent: _v4 } = value;
const { getFiles: _v5 } = value;
const { getInputValue: _v6 } = value;
const { getMentionables: _v7 } = value;
const { getRadioValues: _v8 } = value;
const { getRoles: _v9 } = value;
const { getUsers: _v10 } = value;
const { isModal: _v11 } = value;
const { update: _v12 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'deferUpdate' } },
				{ messageId: 'methodDestructure', data: { name: 'getChannels' } },
				{ messageId: 'methodDestructure', data: { name: 'getCheckbox' } },
				{ messageId: 'methodDestructure', data: { name: 'getCheckboxValues' } },
				{ messageId: 'methodDestructure', data: { name: 'getComponent' } },
				{ messageId: 'methodDestructure', data: { name: 'getFiles' } },
				{ messageId: 'methodDestructure', data: { name: 'getInputValue' } },
				{ messageId: 'methodDestructure', data: { name: 'getMentionables' } },
				{ messageId: 'methodDestructure', data: { name: 'getRadioValues' } },
				{ messageId: 'methodDestructure', data: { name: 'getRoles' } },
				{ messageId: 'methodDestructure', data: { name: 'getUsers' } },
				{ messageId: 'methodDestructure', data: { name: 'isModal' } },
				{ messageId: 'methodDestructure', data: { name: 'update' } },
			],
		},
		{
			name: 'NewsChannel: detached methods',
			filename,
			code: `import { NewsChannel } from 'seyfert';
declare const value: InstanceType<typeof NewsChannel>;
const { addFollower: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'addFollower' } }],
		},
		{
			name: 'OptionResolver: detached methods',
			filename,
			code: `import { OptionResolver } from 'seyfert';
declare const value: InstanceType<typeof OptionResolver>;
const { get: _v0 } = value;
const { getAutocomplete: _v1 } = value;
const { getAutocompleteValue: _v2 } = value;
const { getChannel: _v3 } = value;
const { getCommand: _v4 } = value;
const { getGroup: _v5 } = value;
const { getHoisted: _v6 } = value;
const { getParent: _v7 } = value;
const { getString: _v8 } = value;
const { getSubCommand: _v9 } = value;
const { getValue: _v10 } = value;
const { transformOption: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getAutocomplete' } },
				{ messageId: 'methodDestructure', data: { name: 'getAutocompleteValue' } },
				{ messageId: 'methodDestructure', data: { name: 'getChannel' } },
				{ messageId: 'methodDestructure', data: { name: 'getCommand' } },
				{ messageId: 'methodDestructure', data: { name: 'getGroup' } },
				{ messageId: 'methodDestructure', data: { name: 'getHoisted' } },
				{ messageId: 'methodDestructure', data: { name: 'getParent' } },
				{ messageId: 'methodDestructure', data: { name: 'getString' } },
				{ messageId: 'methodDestructure', data: { name: 'getSubCommand' } },
				{ messageId: 'methodDestructure', data: { name: 'getValue' } },
				{ messageId: 'methodDestructure', data: { name: 'transformOption' } },
			],
		},
		{
			name: 'Poll: detached methods',
			filename,
			code: `import { Poll } from 'seyfert';
declare const value: InstanceType<typeof Poll>;
const { end: _v0 } = value;
const { getAnswerVoters: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'end' } },
				{ messageId: 'methodDestructure', data: { name: 'getAnswerVoters' } },
			],
		},
		{
			name: 'PollBuilder: detached methods',
			filename,
			code: `import { PollBuilder } from 'seyfert';
declare const value: InstanceType<typeof PollBuilder>;
const { addAnswers: _v0 } = value;
const { allowMultiselect: _v1 } = value;
const { setAnswers: _v2 } = value;
const { setDuration: _v3 } = value;
const { setQuestion: _v4 } = value;
const { toJSON: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addAnswers' } },
				{ messageId: 'methodDestructure', data: { name: 'allowMultiselect' } },
				{ messageId: 'methodDestructure', data: { name: 'setAnswers' } },
				{ messageId: 'methodDestructure', data: { name: 'setDuration' } },
				{ messageId: 'methodDestructure', data: { name: 'setQuestion' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'RadioGroup: detached methods',
			filename,
			code: `import { RadioGroup } from 'seyfert';
declare const value: InstanceType<typeof RadioGroup>;
const { addOptions: _v0 } = value;
const { setCustomId: _v1 } = value;
const { setId: _v2 } = value;
const { setOptions: _v3 } = value;
const { setRequired: _v4 } = value;
const { toJSON: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'RadioGroupOption: detached methods',
			filename,
			code: `import { RadioGroupOption } from 'seyfert';
declare const value: InstanceType<typeof RadioGroupOption>;
const { setDefault: _v0 } = value;
const { setDescription: _v1 } = value;
const { setLabel: _v2 } = value;
const { setValue: _v3 } = value;
const { toJSON: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDefault' } },
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setLabel' } },
				{ messageId: 'methodDestructure', data: { name: 'setValue' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'RoleSelectMenu: detached methods',
			filename,
			code: `import { RoleSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof RoleSelectMenu>;
const { addDefaultRoles: _v0 } = value;
const { setDefaultRoles: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addDefaultRoles' } },
				{ messageId: 'methodDestructure', data: { name: 'setDefaultRoles' } },
			],
		},
		{
			name: 'RoleSelectMenuInteraction: detached methods',
			filename,
			code: `import { RoleSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof RoleSelectMenuInteraction>;
const { isRoleSelectMenu: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isRoleSelectMenu' } }],
		},
		{
			name: 'Router: detached methods',
			filename,
			code: `import { Router } from 'seyfert';
declare const value: InstanceType<typeof Router>;
const { createProxy: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'createProxy' } }],
		},
		{
			name: 'Section: detached methods',
			filename,
			code: `import { Section } from 'seyfert';
declare const value: InstanceType<typeof Section>;
const { addComponents: _v0 } = value;
const { setAccessory: _v1 } = value;
const { setComponents: _v2 } = value;
const { toJSON: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'setAccessory' } },
				{ messageId: 'methodDestructure', data: { name: 'setComponents' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'SelectMenu: detached methods',
			filename,
			code: `import { SelectMenu } from 'seyfert';
declare const value: InstanceType<typeof SelectMenu>;
const { setCustomId: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'setCustomId' } }],
		},
		{
			name: 'SelectMenuInteraction: detached methods',
			filename,
			code: `import { SelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof SelectMenuInteraction>;
const { deferReply: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'deferReply' } }],
		},
		{
			name: 'Separator: detached methods',
			filename,
			code: `import { Separator } from 'seyfert';
declare const value: InstanceType<typeof Separator>;
const { setDivider: _v0 } = value;
const { setId: _v1 } = value;
const { setSpacing: _v2 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDivider' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpacing' } },
			],
		},
		{
			name: 'SeyfertError: detached methods',
			filename,
			code: `import { SeyfertError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertError>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'SeyfertPluginAggregateError: detached methods',
			filename,
			code: `import { SeyfertPluginAggregateError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertPluginAggregateError>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'SeyfertPluginError: detached methods',
			filename,
			code: `import { SeyfertPluginError } from 'seyfert';
declare const value: InstanceType<typeof SeyfertPluginError>;
const { toJSON: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'toJSON' } }],
		},
		{
			name: 'ShardManager: detached methods',
			filename,
			code: `import { ShardManager } from 'seyfert';
declare const value: InstanceType<typeof ShardManager>;
const { calculateShardId: _v0 } = value;
const { create: _v1 } = value;
const { disconnect: _v2 } = value;
const { disconnectAll: _v3 } = value;
const { forceIdentify: _v4 } = value;
const { joinVoice: _v5 } = value;
const { leaveVoice: _v6 } = value;
const { requestChannelInfo: _v7 } = value;
const { resume: _v8 } = value;
const { send: _v9 } = value;
const { setPresence: _v10 } = value;
const { setShardPresence: _v11 } = value;
const { spawnBuckets: _v12 } = value;
const { spawnShards: _v13 } = value;
const { startResharder: _v14 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } },
				{ messageId: 'methodDestructure', data: { name: 'create' } },
				{ messageId: 'methodDestructure', data: { name: 'disconnect' } },
				{ messageId: 'methodDestructure', data: { name: 'disconnectAll' } },
				{ messageId: 'methodDestructure', data: { name: 'forceIdentify' } },
				{ messageId: 'methodDestructure', data: { name: 'joinVoice' } },
				{ messageId: 'methodDestructure', data: { name: 'leaveVoice' } },
				{ messageId: 'methodDestructure', data: { name: 'requestChannelInfo' } },
				{ messageId: 'methodDestructure', data: { name: 'resume' } },
				{ messageId: 'methodDestructure', data: { name: 'send' } },
				{ messageId: 'methodDestructure', data: { name: 'setPresence' } },
				{ messageId: 'methodDestructure', data: { name: 'setShardPresence' } },
				{ messageId: 'methodDestructure', data: { name: 'spawnBuckets' } },
				{ messageId: 'methodDestructure', data: { name: 'spawnShards' } },
				{ messageId: 'methodDestructure', data: { name: 'startResharder' } },
			],
		},
		{
			name: 'StageChannel: detached methods',
			filename,
			code: `import { StageChannel } from 'seyfert';
declare const value: InstanceType<typeof StageChannel>;
const { members: _v0 } = value;
const { setBitrate: _v1 } = value;
const { setRTC: _v2 } = value;
const { setUserLimit: _v3 } = value;
const { setVideoQuality: _v4 } = value;
const { setVoiceStatus: _v5 } = value;
const { states: _v6 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'members' } },
				{ messageId: 'methodDestructure', data: { name: 'setBitrate' } },
				{ messageId: 'methodDestructure', data: { name: 'setRTC' } },
				{ messageId: 'methodDestructure', data: { name: 'setUserLimit' } },
				{ messageId: 'methodDestructure', data: { name: 'setVideoQuality' } },
				{ messageId: 'methodDestructure', data: { name: 'setVoiceStatus' } },
				{ messageId: 'methodDestructure', data: { name: 'states' } },
			],
		},
		{
			name: 'Sticker: detached methods',
			filename,
			code: `import { Sticker } from 'seyfert';
declare const value: InstanceType<typeof Sticker>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
			],
		},
		{
			name: 'StringSelectMenu: detached methods',
			filename,
			code: `import { StringSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof StringSelectMenu>;
const { addOption: _v0 } = value;
const { setOptions: _v1 } = value;
const { setRequired: _v2 } = value;
const { toJSON: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addOption' } },
				{ messageId: 'methodDestructure', data: { name: 'setOptions' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'StringSelectMenuInteraction: detached methods',
			filename,
			code: `import { StringSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof StringSelectMenuInteraction>;
const { isStringSelectMenu: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isStringSelectMenu' } }],
		},
		{
			name: 'StringSelectOption: detached methods',
			filename,
			code: `import { StringSelectOption } from 'seyfert';
declare const value: InstanceType<typeof StringSelectOption>;
const { setDefault: _v0 } = value;
const { setDescription: _v1 } = value;
const { setEmoji: _v2 } = value;
const { setLabel: _v3 } = value;
const { setValue: _v4 } = value;
const { toJSON: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDefault' } },
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setEmoji' } },
				{ messageId: 'methodDestructure', data: { name: 'setLabel' } },
				{ messageId: 'methodDestructure', data: { name: 'setValue' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'SubCommand: detached methods',
			filename,
			code: `import { SubCommand } from 'seyfert';
declare const value: InstanceType<typeof SubCommand>;
const { run: _v0 } = value;
const { toJSON: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'run' } },
				{ messageId: 'methodDestructure', data: { name: 'toJSON' } },
			],
		},
		{
			name: 'TextBaseGuildChannel: detached methods',
			filename,
			code: `import { TextBaseGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof TextBaseGuildChannel>;
const { typing: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'typing' } }],
		},
		{
			name: 'TextDisplay: detached methods',
			filename,
			code: `import { TextDisplay } from 'seyfert';
declare const value: InstanceType<typeof TextDisplay>;
const { setContent: _v0 } = value;
const { setId: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setContent' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
			],
		},
		{
			name: 'TextGuildChannel: detached methods',
			filename,
			code: `import { TextGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof TextGuildChannel>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'TextInput: detached methods',
			filename,
			code: `import { TextInput } from 'seyfert';
declare const value: InstanceType<typeof TextInput>;
const { setCustomId: _v0 } = value;
const { setLength: _v1 } = value;
const { setPlaceholder: _v2 } = value;
const { setRequired: _v3 } = value;
const { setStyle: _v4 } = value;
const { setValue: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setCustomId' } },
				{ messageId: 'methodDestructure', data: { name: 'setLength' } },
				{ messageId: 'methodDestructure', data: { name: 'setPlaceholder' } },
				{ messageId: 'methodDestructure', data: { name: 'setRequired' } },
				{ messageId: 'methodDestructure', data: { name: 'setStyle' } },
				{ messageId: 'methodDestructure', data: { name: 'setValue' } },
			],
		},
		{
			name: 'ThreadChannel: detached methods',
			filename,
			code: `import { ThreadChannel } from 'seyfert';
declare const value: InstanceType<typeof ThreadChannel>;
const { join: _v0 } = value;
const { leave: _v1 } = value;
const { pin: _v2 } = value;
const { setArchived: _v3 } = value;
const { setAutoArchiveDuration: _v4 } = value;
const { setInvitable: _v5 } = value;
const { setLocked: _v6 } = value;
const { setRatelimitPerUser: _v7 } = value;
const { setTags: _v8 } = value;
const { unpin: _v9 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'join' } },
				{ messageId: 'methodDestructure', data: { name: 'leave' } },
				{ messageId: 'methodDestructure', data: { name: 'pin' } },
				{ messageId: 'methodDestructure', data: { name: 'setArchived' } },
				{ messageId: 'methodDestructure', data: { name: 'setAutoArchiveDuration' } },
				{ messageId: 'methodDestructure', data: { name: 'setInvitable' } },
				{ messageId: 'methodDestructure', data: { name: 'setLocked' } },
				{ messageId: 'methodDestructure', data: { name: 'setRatelimitPerUser' } },
				{ messageId: 'methodDestructure', data: { name: 'setTags' } },
				{ messageId: 'methodDestructure', data: { name: 'unpin' } },
			],
		},
		{
			name: 'ThreadOnlyMethods: detached methods',
			filename,
			code: `import { ThreadOnlyMethods } from 'seyfert';
declare const value: InstanceType<typeof ThreadOnlyMethods>;
const { thread: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'thread' } }],
		},
		{
			name: 'Thumbnail: detached methods',
			filename,
			code: `import { Thumbnail } from 'seyfert';
declare const value: InstanceType<typeof Thumbnail>;
const { setDescription: _v0 } = value;
const { setId: _v1 } = value;
const { setMedia: _v2 } = value;
const { setSpoiler: _v3 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'setDescription' } },
				{ messageId: 'methodDestructure', data: { name: 'setId' } },
				{ messageId: 'methodDestructure', data: { name: 'setMedia' } },
				{ messageId: 'methodDestructure', data: { name: 'setSpoiler' } },
			],
		},
		{
			name: 'TopicableGuildChannel: detached methods',
			filename,
			code: `import { TopicableGuildChannel } from 'seyfert';
declare const value: InstanceType<typeof TopicableGuildChannel>;
const { setTopic: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'setTopic' } }],
		},
		{
			name: 'UnavailableMember: detached methods',
			filename,
			code: `import { UnavailableMember } from 'seyfert';
declare const value: InstanceType<typeof UnavailableMember>;
const { ban: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'ban' } }],
		},
		{
			name: 'User: detached methods',
			filename,
			code: `import { User } from 'seyfert';
declare const value: InstanceType<typeof User>;
const { fetch: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'fetch' } }],
		},
		{
			name: 'UserCommandInteraction: detached methods',
			filename,
			code: `import { UserCommandInteraction } from 'seyfert';
declare const value: InstanceType<typeof UserCommandInteraction>;
const { isUser: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUser' } }],
		},
		{
			name: 'UserSelectMenu: detached methods',
			filename,
			code: `import { UserSelectMenu } from 'seyfert';
declare const value: InstanceType<typeof UserSelectMenu>;
const { addDefaultUsers: _v0 } = value;
const { setDefaultUsers: _v1 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addDefaultUsers' } },
				{ messageId: 'methodDestructure', data: { name: 'setDefaultUsers' } },
			],
		},
		{
			name: 'UserSelectMenuInteraction: detached methods',
			filename,
			code: `import { UserSelectMenuInteraction } from 'seyfert';
declare const value: InstanceType<typeof UserSelectMenuInteraction>;
const { isUserSelectMenu: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'isUserSelectMenu' } }],
		},
		{
			name: 'VoiceChannel: detached methods',
			filename,
			code: `import { VoiceChannel } from 'seyfert';
declare const value: InstanceType<typeof VoiceChannel>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'VoiceChannelMethods: detached methods',
			filename,
			code: `import { VoiceChannelMethods } from 'seyfert';
declare const value: InstanceType<typeof VoiceChannelMethods>;
const { delete: _v0 } = value;`,
			errors: [{ messageId: 'methodDestructure', data: { name: 'delete' } }],
		},
		{
			name: 'VoiceState: detached methods',
			filename,
			code: `import { VoiceState } from 'seyfert';
declare const value: InstanceType<typeof VoiceState>;
const { channel: _v0 } = value;
const { disconnect: _v1 } = value;
const { fetch: _v2 } = value;
const { guild: _v3 } = value;
const { member: _v4 } = value;
const { requestSpeak: _v5 } = value;
const { setChannel: _v6 } = value;
const { setDeaf: _v7 } = value;
const { setMute: _v8 } = value;
const { setSuppress: _v9 } = value;
const { user: _v10 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'disconnect' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
				{ messageId: 'methodDestructure', data: { name: 'member' } },
				{ messageId: 'methodDestructure', data: { name: 'requestSpeak' } },
				{ messageId: 'methodDestructure', data: { name: 'setChannel' } },
				{ messageId: 'methodDestructure', data: { name: 'setDeaf' } },
				{ messageId: 'methodDestructure', data: { name: 'setMute' } },
				{ messageId: 'methodDestructure', data: { name: 'setSuppress' } },
				{ messageId: 'methodDestructure', data: { name: 'user' } },
			],
		},
		{
			name: 'Webhook: detached methods',
			filename,
			code: `import { Webhook } from 'seyfert';
declare const value: InstanceType<typeof Webhook>;
const { avatarURL: _v0 } = value;
const { channel: _v1 } = value;
const { delete: _v2 } = value;
const { edit: _v3 } = value;
const { fetch: _v4 } = value;
const { guild: _v5 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'avatarURL' } },
				{ messageId: 'methodDestructure', data: { name: 'channel' } },
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'guild' } },
			],
		},
		{
			name: 'WebhookMessage: detached methods',
			filename,
			code: `import { WebhookMessage } from 'seyfert';
declare const value: InstanceType<typeof WebhookMessage>;
const { delete: _v0 } = value;
const { edit: _v1 } = value;
const { fetch: _v2 } = value;
const { fetchWebhook: _v3 } = value;
const { write: _v4 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'delete' } },
				{ messageId: 'methodDestructure', data: { name: 'edit' } },
				{ messageId: 'methodDestructure', data: { name: 'fetch' } },
				{ messageId: 'methodDestructure', data: { name: 'fetchWebhook' } },
				{ messageId: 'methodDestructure', data: { name: 'write' } },
			],
		},
		{
			name: 'WorkerAdapter: detached methods',
			filename,
			code: `import { WorkerAdapter } from 'seyfert';
declare const value: InstanceType<typeof WorkerAdapter>;
const { addToRelationship: _v0 } = value;
const { bulkAddToRelationShip: _v1 } = value;
const { bulkGet: _v2 } = value;
const { bulkPatch: _v3 } = value;
const { bulkRemove: _v4 } = value;
const { bulkSet: _v5 } = value;
const { contains: _v6 } = value;
const { count: _v7 } = value;
const { flush: _v8 } = value;
const { get: _v9 } = value;
const { getToRelationship: _v10 } = value;
const { keys: _v11 } = value;
const { patch: _v12 } = value;
const { postMessage: _v13 } = value;
const { remove: _v14 } = value;
const { removeRelationship: _v15 } = value;
const { removeToRelationship: _v16 } = value;
const { scan: _v17 } = value;
const { send: _v18 } = value;
const { set: _v19 } = value;
const { start: _v20 } = value;
const { values: _v21 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'addToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkAddToRelationShip' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkGet' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkPatch' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkRemove' } },
				{ messageId: 'methodDestructure', data: { name: 'bulkSet' } },
				{ messageId: 'methodDestructure', data: { name: 'contains' } },
				{ messageId: 'methodDestructure', data: { name: 'count' } },
				{ messageId: 'methodDestructure', data: { name: 'flush' } },
				{ messageId: 'methodDestructure', data: { name: 'get' } },
				{ messageId: 'methodDestructure', data: { name: 'getToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'keys' } },
				{ messageId: 'methodDestructure', data: { name: 'patch' } },
				{ messageId: 'methodDestructure', data: { name: 'postMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'remove' } },
				{ messageId: 'methodDestructure', data: { name: 'removeRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'removeToRelationship' } },
				{ messageId: 'methodDestructure', data: { name: 'scan' } },
				{ messageId: 'methodDestructure', data: { name: 'send' } },
				{ messageId: 'methodDestructure', data: { name: 'set' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 'values' } },
			],
		},
		{
			name: 'WorkerClient: detached methods',
			filename,
			code: `import { WorkerClient } from 'seyfert';
declare const value: InstanceType<typeof WorkerClient>;
const { calculateShardId: _v0 } = value;
const { createShard: _v1 } = value;
const { handleManagerMessages: _v2 } = value;
const { loadEvents: _v3 } = value;
const { onPacket: _v4 } = value;
const { postMessage: _v5 } = value;
const { resumeShard: _v6 } = value;
const { setServices: _v7 } = value;
const { setWorkerData: _v8 } = value;
const { start: _v9 } = value;
const { tellWorker: _v10 } = value;
const { tellWorkers: _v11 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } },
				{ messageId: 'methodDestructure', data: { name: 'createShard' } },
				{ messageId: 'methodDestructure', data: { name: 'handleManagerMessages' } },
				{ messageId: 'methodDestructure', data: { name: 'loadEvents' } },
				{ messageId: 'methodDestructure', data: { name: 'onPacket' } },
				{ messageId: 'methodDestructure', data: { name: 'postMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'resumeShard' } },
				{ messageId: 'methodDestructure', data: { name: 'setServices' } },
				{ messageId: 'methodDestructure', data: { name: 'setWorkerData' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 'tellWorker' } },
				{ messageId: 'methodDestructure', data: { name: 'tellWorkers' } },
			],
		},
		{
			name: 'WorkerManager: detached methods',
			filename,
			code: `import { WorkerManager } from 'seyfert';
declare const value: InstanceType<typeof WorkerManager>;
const { calculateShardId: _v0 } = value;
const { calculateWorkerId: _v1 } = value;
const { createWorker: _v2 } = value;
const { getShardInfo: _v3 } = value;
const { getWorkerInfo: _v4 } = value;
const { handleWorkerMessage: _v5 } = value;
const { postMessage: _v6 } = value;
const { prepareWorkers: _v7 } = value;
const { send: _v8 } = value;
const { setCache: _v9 } = value;
const { setRest: _v10 } = value;
const { spawn: _v11 } = value;
const { start: _v12 } = value;
const { startResharding: _v13 } = value;
const { syncLatency: _v14 } = value;
const { tellWorker: _v15 } = value;
const { tellWorkers: _v16 } = value;`,
			errors: [
				{ messageId: 'methodDestructure', data: { name: 'calculateShardId' } },
				{ messageId: 'methodDestructure', data: { name: 'calculateWorkerId' } },
				{ messageId: 'methodDestructure', data: { name: 'createWorker' } },
				{ messageId: 'methodDestructure', data: { name: 'getShardInfo' } },
				{ messageId: 'methodDestructure', data: { name: 'getWorkerInfo' } },
				{ messageId: 'methodDestructure', data: { name: 'handleWorkerMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'postMessage' } },
				{ messageId: 'methodDestructure', data: { name: 'prepareWorkers' } },
				{ messageId: 'methodDestructure', data: { name: 'send' } },
				{ messageId: 'methodDestructure', data: { name: 'setCache' } },
				{ messageId: 'methodDestructure', data: { name: 'setRest' } },
				{ messageId: 'methodDestructure', data: { name: 'spawn' } },
				{ messageId: 'methodDestructure', data: { name: 'start' } },
				{ messageId: 'methodDestructure', data: { name: 'startResharding' } },
				{ messageId: 'methodDestructure', data: { name: 'syncLatency' } },
				{ messageId: 'methodDestructure', data: { name: 'tellWorker' } },
				{ messageId: 'methodDestructure', data: { name: 'tellWorkers' } },
			],
		},
	],
});
