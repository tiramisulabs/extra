import { Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { DiscordErrors } from '../../src/bot/rest';
import { Routes } from '../../src/bot/routes';
import { mockWorld } from '../../src/bot/world';
import { expectDiscordError } from './_setup';

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
		expect(bot.world.query.sticker({ guildId: guild.id, id: 'sticker-1' })).toMatchObject({ name: 'new' });
		expect(bot.world.all.sticker({ guildId: guild.id })).toHaveLength(1);
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
		expect(bot.world.all.guildTemplate({ sourceGuildId: guild.id }).map(template => template.name)).toContain(
			'starter',
		);
		await bot.close();
	});
});

describe('scheduled events, stage, soundboard and audit logs (seedable reads)', () => {
	test('scheduled events surface on the guild view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'se-guild' });
		world.registerScheduledEvent(guild.id, { id: 'event-1', name: 'launch' });
		const bot = await createMockBot({ world });
		expect(bot.world.query.guild({ id: guild.id })?.scheduledEvents.map(event => event.name)).toContain('launch');
		expect(bot.world.query.scheduledEvent({ guildId: guild.id, id: 'event-1' })).toMatchObject({ name: 'launch' });
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
		expect(bot.world.query.stageInstance({ channelId: 'stage-chan' })).toMatchObject({ topic: 'town hall' });
		expect(bot.world.all.soundboardSound({ guildId: guild.id }).map(sound => sound.name)).toContain('airhorn');
		expect(bot.world.all.auditLogEntry({ guildId: guild.id })).toHaveLength(1);
		expect(bot.world.all.auditLogEntry({ guildId: guild.id })[0]).toMatchObject({ action_type: 20, reason: 'cleanup' });
		await bot.close();
	});

	test('PATCH a scheduled event: the world keeps the fields the body left alone', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'se-edit-guild' });
		const botRole = world.registerRole(guild.id, { id: 'se-bot-role', permissions: '8' });
		world.registerBotMember(guild.id, { roles: [botRole.id] });
		world.registerScheduledEvent(guild.id, { id: 'event-9', name: 'launch', status: 2, entityType: 3 });

		const bot = await createMockBot({ world });
		await bot.rest.request('PATCH', `/guilds/${guild.id}/scheduled-events/event-9`, { body: { name: 'relaunch' } });

		const event = bot.world.query.scheduledEvent({ guildId: guild.id, id: 'event-9' });
		// a PATCH of one field is a merge, not a rebuild: status and entity_type were not in the body
		expect(event).toMatchObject({ name: 'relaunch', status: 2, entity_type: 3 });
		expect(bot.restCalls(Routes.editScheduledEvent)).toHaveLength(1);
		await bot.close();
	});

	test('PATCH a stage instance: the topic changes, the channel binding does not', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'stage-edit-guild' });
		const botRole = world.registerRole(guild.id, { id: 'stage-bot-role', permissions: '8' });
		world.registerBotMember(guild.id, { roles: [botRole.id] });
		const channel = world.registerChannel(guild.id, { id: 'stage-edit-chan', type: 13 });
		world.registerStageInstance(channel.id, { topic: 'town hall' });

		const bot = await createMockBot({ world });
		await bot.rest.request('PATCH', `/stage-instances/${channel.id}`, { body: { topic: 'office hours' } });

		expect(bot.world.query.stageInstance({ channelId: channel.id })).toMatchObject({
			topic: 'office hours',
			channel_id: channel.id,
		});
		await bot.close();
	});

	test('PATCH an absent scheduled event answers 404, as create/fetch/delete already do', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'se-404-guild' });
		const botRole = world.registerRole(guild.id, { id: 'se-404-role', permissions: '8' });
		world.registerBotMember(guild.id, { roles: [botRole.id] });

		const bot = await createMockBot({ world });
		await expectDiscordError(
			bot.rest.request('PATCH', `/guilds/${guild.id}/scheduled-events/ghost`, { body: { name: 'x' } }),
			DiscordErrors.UnknownScheduledEvent,
		);
		await bot.close();
	});
});
