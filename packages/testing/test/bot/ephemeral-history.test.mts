import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	Declare,
	MessageFlags,
	PermissionFlagsBits,
} from 'seyfert';
import { expect, test } from 'vitest';
import { createMockBot } from '../../src';
import { memberAddEvent } from '../../src/bot/payload-events';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

test('deferred ephemeral button reply stays private after editOrReply without flags', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'ephemeral-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'ephemeral-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'ephemeral-other' }) });
	world.registerMessage(channel.id, {
		id: 'ephemeral-button-source',
		components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Open', custom_id: 'ephemeral-open' }] }],
	});
	class Open extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'ephemeral-open';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.interaction.deferReply(MessageFlags.Ephemeral);
			await ctx.editOrReply({ content: 'owner only' });
		}
	}
	const bot = await createMockBot({ components: [Open], world });
	try {
		await bot.clickButton('ephemeral-open', { source: 'ephemeral-button-source', user: owner.user, channel });
		const owned = bot.conversation({ userId: owner.user.id, channelId: channel.id });
		const reply = owned.messages.find(message => message.payload.content === 'owner only');
		expect((reply?.payload.flags ?? 0) & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
		expect(reply?.ownerId).toBe(owner.user.id);
		expect(bot.conversation({ userId: other.user.id, channelId: channel.id }).messages).not.toContainEqual(reply);
		expect(bot.inspectChannel(channel.id).messages).toContainEqual(
			expect.objectContaining({
				id: reply?.id,
				ownerId: owner.user.id,
				visibility: 'ephemeral',
			}),
		);
	} finally {
		await bot.close();
	}
});

test('loading and first followup retain the deferred original visibility', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'followup-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'followup-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'followup-other' }) });
	let loadingFlags = 0;
	let otherSawLoading = false;
	let bot: Awaited<ReturnType<typeof createMockBot>>;
	@Declare({ name: 'deferred-followup', description: 'Deferred followup' })
	class Deferred extends Command {
		async run(ctx: CommandContext) {
			await ctx.deferReply(true);
			loadingFlags = bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages[0]?.payload.flags ?? 0;
			otherSawLoading = bot.conversation({ userId: other.user.id, channelId: channel.id }).messages.length > 0;
			await ctx.followup({ content: 'first followup' });
			await ctx.followup({ content: 'second followup', flags: MessageFlags.Ephemeral });
		}
	}
	@Declare({ name: 'public-deferred', description: 'Public deferred followup' })
	class PublicDeferred extends Command {
		async run(ctx: CommandContext) {
			await ctx.deferReply();
			await ctx.followup({ content: 'public first followup', flags: MessageFlags.Ephemeral });
		}
	}
	bot = await createMockBot({ commands: [Deferred, PublicDeferred], world });
	try {
		await bot.slash({ name: 'deferred-followup', user: owner.user, guildId: guild.id, channel });
		expect(loadingFlags & 192).toBe(192);
		expect(otherSawLoading).toBe(false);
		const ownerMessages = bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages;
		expect(ownerMessages.map(message => message.payload.content)).toEqual(['first followup', 'second followup']);
		expect((ownerMessages[0].payload.flags ?? 0) & 192).toBe(64);
		expect((ownerMessages[1].payload.flags ?? 0) & 64).toBe(64);
		expect(bot.conversation({ userId: other.user.id, channelId: channel.id }).messages).toEqual([]);
		await bot.slash({ name: 'public-deferred', user: owner.user, guildId: guild.id, channel });
		expect(
			bot
				.conversation({ userId: other.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['public first followup']);
		expect(
			(bot.conversation({ userId: other.user.id, channelId: channel.id }).messages[0]?.payload.flags ?? 0) & 64,
		).toBe(0);
	} finally {
		await bot.close();
	}
});

test('deferred component update edits the source without changing its ephemeral owner', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'update-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'update-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'update-other' }) });
	world.registerMessage(channel.id, {
		id: 'private-source',
		ownerId: owner.user.id,
		flags: MessageFlags.Ephemeral,
		components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Edit', custom_id: 'update-private' }] }],
	});
	class Update extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'update-private';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.deferUpdate();
			await ctx.editOrReply({ content: 'updated source' });
		}
	}
	const bot = await createMockBot({ components: [Update], world });
	try {
		await bot.clickButton('update-private', { source: 'private-source', user: owner.user, channel });
		expect(bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages).toMatchObject([
			{ id: 'private-source', ownerId: owner.user.id, visibility: 'ephemeral', payload: { content: 'updated source' } },
		]);
		expect(bot.conversation({ userId: other.user.id, channelId: channel.id }).messages).toEqual([]);
		expect(bot.inspectChannel(channel.id).messages).toHaveLength(1);
	} finally {
		await bot.close();
	}
});

test('direct and later ephemeral followups keep their visibility after edits', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'direct-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'direct-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'direct-other' }) });
	@Declare({ name: 'direct-private', description: 'Private reply' })
	class Private extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'private original', flags: MessageFlags.Ephemeral });
			await ctx.editResponse({ content: 'private edited' });
		}
	}
	@Declare({ name: 'public-then-private', description: 'Public then private' })
	class Public extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'public original' });
			await ctx.followup({ content: 'private followup', flags: MessageFlags.Ephemeral });
		}
	}
	const bot = await createMockBot({ commands: [Private, Public], world });
	try {
		await bot.slash({ name: 'direct-private', user: owner.user, guildId: guild.id, channel });
		const result = await bot.slash({ name: 'public-then-private', user: owner.user, guildId: guild.id, channel });
		const ownerMessages = bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages;
		const privateFollowup = ownerMessages.find(message => message.payload.content === 'private followup');
		expect(
			bot
				.inspectChannel(channel.id)
				.messages.filter(message => message.visibility === 'ephemeral')
				.map(message => message.liveRecipientIds),
		).toEqual([[owner.user.id], [owner.user.id]]);
		expect((ownerMessages.find(message => message.payload.content === 'private edited')?.payload.flags ?? 0) & 64).toBe(
			64,
		);
		expect(
			bot
				.conversation({ userId: other.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['public original']);
		const route = result.actions.find(action => action.route.includes('/webhooks/') && action.method === 'POST')?.route;
		if (!route || !privateFollowup) throw new Error('expected private followup route and message');
		await bot.rest.request('PATCH', `${route}/messages/${privateFollowup.id}` as `/${string}`, {
			body: { content: 'private followup edited', flags: 0 },
		});
		expect(
			(bot
				.conversation({ userId: owner.user.id, channelId: channel.id })
				.messages.find(message => message.id === privateFollowup.id)?.payload.flags ?? 0) & 64,
		).toBe(64);
		expect(
			bot
				.conversation({ userId: other.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['public original']);
	} finally {
		await bot.close();
	}
});

test('history permission and overwrites use current permissions', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({
		id: 'history-guild',
		ownerId: 'history-owner',
		everyonePermissions: ['ViewChannel'],
	});
	const read = world.registerRole(guild.id, { id: 'history-reader', permissions: ['ReadMessageHistory'] });
	const manage = world.registerRole(guild.id, { id: 'history-manager', permissions: ['ManageRoles'] });
	const admin = world.registerRole(guild.id, { id: 'history-admin', permissions: ['Administrator'] });
	const channel = world.registerChannel(guild.id);
	const denied = world.registerChannel(guild.id, {
		overwrites: [{ id: read.id, type: 'role', deny: ['ReadMessageHistory'] }],
	});
	const allowed = world.registerChannel(guild.id, {
		overwrites: [{ id: guild.id, type: 'role', allow: ['ReadMessageHistory'] }],
	});
	const alice = world.registerMember(guild.id, { user: apiUser({ id: 'history-alice' }) });
	const bob = world.registerMember(guild.id, { user: apiUser({ id: 'history-bob' }), roles: [read.id] });
	const carol = world.registerMember(guild.id, { user: apiUser({ id: 'history-carol' }), roles: [admin.id] });
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'history-owner' }) });
	world.registerBotMember(guild.id, { roles: [manage.id] });
	world.registerMessage(channel.id, { id: 'history-seed', content: 'seed' });
	world.registerMessage(channel.id, {
		id: 'history-private',
		content: 'mine',
		flags: MessageFlags.Ephemeral,
		ownerId: alice.user.id,
	});
	world.registerMessage(denied.id, { content: 'denied seed' });
	world.registerMessage(allowed.id, { content: 'allowed seed' });
	const bot = await createMockBot({ world });
	try {
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['mine']);
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
		expect(
			bot.conversation({ userId: bob.user.id, channelId: channel.id }).messages.map(message => message.payload.content),
		).toEqual(['seed']);
		expect(bot.conversation({ userId: bob.user.id, channelId: denied.id }).diagnostics).toContain('history-hidden:1');
		expect(bot.conversation({ userId: alice.user.id, channelId: allowed.id }).messages).toHaveLength(1);
		expect(bot.conversation({ userId: carol.user.id, channelId: denied.id }).messages).toHaveLength(1);
		expect(bot.conversation({ userId: owner.user.id, channelId: denied.id }).messages).toHaveLength(1);
		expect(bot.inspectChannel(channel.id).messages).toMatchObject([
			{ id: 'history-seed', sequence: 1, isHistory: true },
			{ id: 'history-private', ownerId: alice.user.id, isHistory: true },
		]);
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'live' } });
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['mine', 'live']);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['seed', 'mine', 'live']);
		await bot.admin.removeMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['mine', 'live']);
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
		await bot.rest.request('PUT', `/channels/${channel.id}/permissions/${alice.user.id}`, {
			body: { type: 1, allow: PermissionFlagsBits.ReadMessageHistory.toString(), deny: '0' },
		});
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['seed', 'mine', 'live']);
		await bot.rest.request('PUT', `/channels/${channel.id}/permissions/${alice.user.id}`, {
			body: { type: 1, allow: '0', deny: PermissionFlagsBits.ReadMessageHistory.toString() },
		});
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
	} finally {
		await bot.close();
	}
});

test('live receipts preserve permission-at-delivery across role changes, edits, and actors', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'receipt-guild', everyonePermissions: [] });
	const view = world.registerRole(guild.id, { id: 'receipt-view', permissions: ['ViewChannel'] });
	const read = world.registerRole(guild.id, { id: 'receipt-read', permissions: ['ReadMessageHistory'] });
	const channel = world.registerChannel(guild.id);
	const alice = world.registerMember(guild.id, { user: apiUser({ id: 'receipt-alice' }) });
	const bob = world.registerMember(guild.id, { user: apiUser({ id: 'receipt-bob' }), roles: [view.id] });
	const bot = await createMockBot({ world });
	try {
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'before view' } });
		await bot.admin.addMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: view.id });
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).messages).toEqual([]);
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'after view' } });
		const before = bot.inspectChannel(channel.id).messages[0];
		const after = bot.inspectChannel(channel.id).messages[1];
		expect(before.liveRecipientIds).toEqual([bob.user.id]);
		expect(after.liveRecipientIds).toEqual([alice.user.id, bob.user.id]);
		expect(after.sequence).toBeGreaterThan(before.sequence ?? 0);
		await bot.rest.request('PATCH', `/channels/${channel.id}/messages/${after.id}`, {
			body: { content: 'edited live' },
		});
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['edited live']);
		expect(
			bot.conversation({ userId: bob.user.id, channelId: channel.id }).messages.map(message => message.payload.content),
		).toEqual(['before view', 'edited live']);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(
			bot
				.conversation({ userId: alice.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toEqual(['before view', 'edited live']);
		await bot.admin.removeMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: view.id });
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id })).toMatchObject({
			messages: [],
			diagnostics: ['no-view-channel'],
		});
		expect(bot.conversation({ userId: bob.user.id, channelId: channel.id }).messages).toHaveLength(2);
	} finally {
		await bot.close();
	}
});

test('a joining member receives only later messages without history permission', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'join-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const bot = await createMockBot({ world });
	try {
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'before join' } });
		const newcomer = apiUser({ id: 'late-member' });
		await bot.emit('GUILD_MEMBER_ADD', memberAddEvent({ user: newcomer }, { guildId: guild.id }), {
			allowNoHandler: true,
		});
		expect(bot.conversation({ userId: newcomer.id, channelId: channel.id }).messages).toEqual([]);
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'after join' } });
		expect(
			bot.conversation({ userId: newcomer.id, channelId: channel.id }).messages.map(message => message.payload.content),
		).toEqual(['after join']);
		expect(bot.inspectChannel(channel.id).messages.map(message => message.liveRecipientIds)).toEqual([
			[],
			[newcomer.id],
		]);
	} finally {
		await bot.close();
	}
});
