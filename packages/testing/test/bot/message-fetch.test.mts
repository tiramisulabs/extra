import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('single message fetch', () => {
	test('resolves a seeded message from state instead of a synthetic fallback', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fetch-one-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fetch-one-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'fetch-one-channel' });
		world.registerMessage(channel.id, { id: 'seeded-message', content: 'real content' });

		let seededContent: string | undefined;
		let seededId: string | undefined;
		let fallbackContent: string | undefined;

		@Declare({ name: 'fetch-one', description: 'Fetches a single message' })
		class FetchOne extends Command {
			async run(ctx: CommandContext) {
				const seeded = await ctx.client.messages.fetch('seeded-message', channel.id, true);
				seededContent = seeded.content;
				seededId = seeded.id;
				const fallback = await ctx.client.messages.fetch('not-seeded', channel.id, true);
				fallbackContent = fallback.content;
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [FetchOne], world });
		await bot.slash({ name: 'fetch-one', guildId: guild.id, channel, user: actor.user });

		expect(seededId).toBe('seeded-message');
		expect(seededContent).toBe('real content');
		expect(fallbackContent).not.toBe('real content');
		await bot.close();
	});
});

describe('message list pagination', () => {
	async function fetchIds(query: Record<string, unknown>): Promise<string[]> {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'page-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'page-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'page-channel' });
		for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
			world.registerMessage(channel.id, { id, content: id });
		}

		let ids: string[] = [];

		@Declare({ name: 'page', description: 'Fetches a page of messages' })
		class Page extends Command {
			async run(ctx: CommandContext) {
				const messages = await ctx.client.channels.fetchMessages(channel.id, query);
				ids = messages.map(message => message.id);
				await ctx.write({ content: ids.join(',') || 'none' });
			}
		}

		const bot = await createMockBot({ commands: [Page], world });
		await bot.slash({ name: 'page', guildId: guild.id, channel, user: actor.user });
		await bot.close();
		return ids;
	}

	test('honors limit and returns newest-first', async () => {
		expect(await fetchIds({ limit: 2 })).toEqual(['m5', 'm4']);
	});

	test('before returns only older messages (newest-first)', async () => {
		expect(await fetchIds({ before: 'm3' })).toEqual(['m2', 'm1']);
	});

	test('after returns only newer messages (newest-first)', async () => {
		expect(await fetchIds({ after: 'm3' })).toEqual(['m5', 'm4']);
	});

	test('limit composes with before', async () => {
		expect(await fetchIds({ before: 'm5', limit: 2 })).toEqual(['m4', 'm3']);
	});

	test('before the oldest message returns empty', async () => {
		expect(await fetchIds({ before: 'm1' })).toEqual([]);
	});

	test('after the newest message returns empty', async () => {
		expect(await fetchIds({ after: 'm5' })).toEqual([]);
	});

	test('limit: 0 returns empty', async () => {
		expect(await fetchIds({ limit: 0 })).toEqual([]);
	});

	// Discord rejects an out-of-range before/after id, but the mock has no such validation: an unknown
	// anchor falls back to the unfiltered newest-first page. Pinned here so the fallback cannot drift silently.
	test('before an unknown id falls back to the full newest-first page', async () => {
		expect(await fetchIds({ before: 'does-not-exist' })).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
	});

	test('after an unknown id falls back to the full newest-first page', async () => {
		expect(await fetchIds({ after: 'does-not-exist' })).toEqual(['m5', 'm4', 'm3', 'm2', 'm1']);
	});
});
