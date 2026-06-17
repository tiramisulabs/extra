import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

const englishLang = { greeting: 'Hello!' };

declare module 'seyfert' {
	interface SeyfertRegistry {
		langs: typeof englishLang;
	}
}

describe('world threads', () => {
	test('registers a thread under a channel, distinct from a normal channel', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'thread-guild' });
		const parent = world.registerChannel(guild.id, { id: 'parent-channel', name: 'general' });
		const thread = world.registerThread(parent.id, { name: 'sprint-planning' });

		expect(thread.parent_id).toBe(parent.id);
		expect(thread.guild_id).toBe(guild.id);
		expect(thread.type).toBe(11);
		expect(thread.thread_metadata).toMatchObject({ archived: false, auto_archive_duration: 1440, locked: false });

		await using bot = await createMockBot({ world });
		const view = bot.worldGuild(guild.id);

		const threadView = view?.thread('sprint-planning');
		expect(threadView?.id).toBe(thread.id);
		expect(threadView?.parentId).toBe(parent.id);
		expect(threadView?.threadMetadata).toMatchObject({ archived: false, locked: false });

		expect(view?.threads.map(t => t.id)).toEqual([thread.id]);
		expect(view?.channels.map(c => c.id)).toEqual([parent.id]);
		expect(view?.channel('general')?.threadMetadata).toBeUndefined();
		expect(view?.thread(parent.id)).toBeUndefined();
	});

	test('a command can fetch a seeded thread and read its parent + metadata', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fetch-thread-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-thread-actor' }) });
		const parent = world.registerChannel(guild.id, { id: 'fetch-parent', name: 'general' });
		const thread = world.registerThread(parent.id, { id: 'seeded-thread', name: 'design', type: 12, locked: true });

		let fetchedParentId: string | undefined;
		let fetchedArchived: boolean | undefined;
		let fetchedLocked: boolean | undefined;

		@Declare({ name: 'read-thread', description: 'Reads a thread' })
		class ReadThread extends Command {
			async run(ctx: CommandContext) {
				const fetched = (await ctx.client.channels.fetch(thread.id)) as unknown as {
					parentId?: string;
					threadMetadata?: { archived: boolean; locked: boolean };
				};
				fetchedParentId = fetched.parentId;
				fetchedArchived = fetched.threadMetadata?.archived;
				fetchedLocked = fetched.threadMetadata?.locked;
				await ctx.write({ content: 'ok' });
			}
		}

		await using bot = await createMockBot({ commands: [ReadThread], world });
		await bot.slash({ name: 'read-thread', guildId: guild.id, channel: parent, user: actor.user });

		expect(fetchedParentId).toBe(parent.id);
		expect(fetchedArchived).toBe(false);
		expect(fetchedLocked).toBe(true);
	});

	test('a runtime-created thread coexists with a seeded one and carries metadata', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'coexist-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'coexist-actor' }) });
		const parent = world.registerChannel(guild.id, { id: 'coexist-parent', name: 'general' });
		world.registerThread(parent.id, { id: 'seeded', name: 'seeded-thread' });

		@Declare({ name: 'spawn-thread', description: 'Creates a thread' })
		class SpawnThread extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.threads.create(parent.id, { name: 'runtime-thread', type: 11, auto_archive_duration: 60 });
				await ctx.write({ content: 'spawned' });
			}
		}

		await using bot = await createMockBot({ commands: [SpawnThread], world });
		await bot.slash({ name: 'spawn-thread', guildId: guild.id, channel: parent, user: actor.user });

		const threads = bot.worldGuild(guild.id)?.threads ?? [];
		expect(threads.map(t => t.name).sort()).toEqual(['runtime-thread', 'seeded-thread']);
		const runtime = bot.worldGuild(guild.id)?.thread('runtime-thread');
		expect(runtime?.parentId).toBe(parent.id);
		expect(runtime?.threadMetadata).toMatchObject({ archived: false, locked: false });
	});
});

describe('world voice states', () => {
	test('registers a voice state readable via bot.worldVoiceState and the cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'voice-guild' });
		const member = world.registerMember(guild.id, { user: apiUser({ id: 'voice-user' }) });
		const channel = world.registerChannel(guild.id, { id: 'voice-channel', name: 'Voice', type: 2 });
		world.registerVoiceState(guild.id, {
			userId: member.user.id,
			channelId: channel.id,
			selfMute: true,
			deaf: true,
		});

		await using bot = await createMockBot({ world });

		const voice = bot.worldVoiceState(guild.id, member.user.id);
		expect(voice?.channel_id).toBe(channel.id);
		expect(voice?.user_id).toBe(member.user.id);
		expect(voice?.self_mute).toBe(true);
		expect(voice?.deaf).toBe(true);

		const cached = await bot.client.cache.voiceStates?.get(member.user.id, guild.id);
		expect(cached?.channelId).toBe(channel.id);

		expect(bot.worldVoiceState(guild.id, 'absent-user')).toBeUndefined();

		expect(bot.worldVoiceState(guild.id, member.user.id)).toEqual(voice);
	});

	test('a command reads a seeded voice state from the cache', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'voice-cmd-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'voice-cmd-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'voice-cmd-channel', name: 'general' });
		const voiceChannel = world.registerChannel(guild.id, { id: 'voice-cmd-voice', name: 'Voice', type: 2 });
		world.registerVoiceState(guild.id, { userId: actor.user.id, channelId: voiceChannel.id });

		let readChannelId: string | null | undefined;

		@Declare({ name: 'read-voice', description: 'Reads a voice state' })
		class ReadVoice extends Command {
			async run(ctx: CommandContext) {
				const state = await ctx.client.cache.voiceStates?.get(actor.user.id, ctx.guildId ?? '');
				readChannelId = state?.channelId;
				await ctx.write({ content: 'ok' });
			}
		}

		await using bot = await createMockBot({ commands: [ReadVoice], world });
		await bot.slash({ name: 'read-voice', guildId: guild.id, channel, user: actor.user });

		expect(readChannelId).toBe(voiceChannel.id);
	});
});
