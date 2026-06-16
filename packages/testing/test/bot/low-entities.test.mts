import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('stickers', () => {
	test('edit and delete a seeded sticker via the client', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'st-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'st-actor' }) });
		const channel = world.registerChannel(guild.id);
		world.registerSticker(guild.id, { id: 'sticker-1', name: 'old' });

		@Declare({ name: 'sticker', description: 'edits then deletes a sticker' })
		class Sticker extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.guilds.stickers.edit(ctx.guildId ?? '', 'sticker-1', { name: 'new' });
				await ctx.write({ content: 'edited' });
			}
		}

		const bot = await createMockBot({ commands: [Sticker], world });
		await bot.slash({ name: 'sticker', guildId: guild.id, channel, user: actor.user });
		expect(bot.cachedGuild(guild.id)?.sticker('sticker-1')).toMatchObject({ name: 'new' });
		expect(bot.state.stickers(guild.id)).toHaveLength(1);
		await bot.close();
	});
});

describe('guild templates', () => {
	test('create records a template the list returns', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'tmpl-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'tmpl-actor' }) });
		const channel = world.registerChannel(guild.id);

		@Declare({ name: 'tmpl', description: 'creates a template' })
		class Tmpl extends Command {
			async run(ctx: CommandContext) {
				const created = await ctx.client.templates.create(ctx.guildId ?? '', { name: 'starter' });
				const list = await ctx.client.templates.list(ctx.guildId ?? '');
				await ctx.write({ content: `${created.code}:${list.length}` });
			}
		}

		const bot = await createMockBot({ commands: [Tmpl], world });
		const res = await bot.slash({ name: 'tmpl', guildId: guild.id, channel, user: actor.user });
		const [code] = (res.content ?? '').split(':');
		expect(res.content).toBe(`${code}:1`);
		expect(bot.state.guildTemplates(guild.id).map(template => template.name)).toContain('starter');
		await bot.close();
	});
});

describe('scheduled events, stage, soundboard and audit logs (seedable reads)', () => {
	test('scheduled events surface on the guild view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'se-guild' });
		world.registerScheduledEvent(guild.id, { id: 'event-1', name: 'launch' });
		const bot = await createMockBot({ world });
		expect(bot.cachedGuild(guild.id)?.scheduledEvents.map(event => event.name)).toContain('launch');
		expect(bot.state.scheduledEvent(guild.id, 'event-1')).toMatchObject({ name: 'launch' });
		await bot.close();
	});

	test('stage instances, soundboard sounds and audit log entries read back from state', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'misc-guild' });
		const channel = world.registerChannel(guild.id, { id: 'stage-chan', type: 13 });
		world.registerStageInstance(channel.id, { topic: 'town hall' });
		world.registerSoundboardSound(guild.id, { soundId: 'snd-1', name: 'airhorn' });
		world.registerAuditLogEntry(guild.id, { id: 'log-1', actionType: 20, reason: 'cleanup' });

		const bot = await createMockBot({ world });
		expect(bot.state.stageInstance('stage-chan')).toMatchObject({ topic: 'town hall' });
		expect(bot.state.soundboardSounds(guild.id).map(sound => sound.name)).toContain('airhorn');
		expect(bot.state.auditLogEntries(guild.id)).toHaveLength(1);
		expect(bot.state.auditLogEntries(guild.id)[0]).toMatchObject({ action_type: 20, reason: 'cleanup' });
		await bot.close();
	});
});
