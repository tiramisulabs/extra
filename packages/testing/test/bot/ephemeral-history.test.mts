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
import { createMockBot, type MockBot } from '../../src';
import type { VisibleMessage } from '../../src/bot/observation';
import { memberAddEvent } from '../../src/bot/payload-events';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

function visibilityFixture(tag: string) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: `${tag}-guild`, everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-owner` }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-other` }) });
	return { world, guild, channel, owner, other };
}

function contents(bot: MockBot, userId: string, channelId: string): (string | undefined)[] {
	return bot.conversation({ userId, channelId }).messages.map(message => message.payload.content);
}

type Seen = [content: string, visibility: 'public' | 'ephemeral'][];

test.each<{ name: string; respond: (ctx: CommandContext) => Promise<unknown>; owner: Seen; other: Seen }>([
	{
		name: 'an ephemeral defer edited without flags stays private',
		respond: async ctx => {
			await ctx.deferReply(true);
			await ctx.editOrReply({ content: 'owner only' });
		},
		owner: [['owner only', 'ephemeral']],
		other: [],
	},
	{
		name: 'the first followup fills an ephemeral defer; later followups keep their own flags',
		respond: async ctx => {
			await ctx.deferReply(true);
			await ctx.followup({ content: 'first followup' });
			await ctx.followup({ content: 'second followup', flags: MessageFlags.Ephemeral });
		},
		owner: [
			['first followup', 'ephemeral'],
			['second followup', 'ephemeral'],
		],
		other: [],
	},
	{
		name: 'the first followup fills a public defer even when flagged ephemeral',
		respond: async ctx => {
			await ctx.deferReply();
			await ctx.followup({ content: 'public first followup', flags: MessageFlags.Ephemeral });
		},
		owner: [['public first followup', 'public']],
		other: [['public first followup', 'public']],
	},
	{
		name: 'an ephemeral original stays private after editResponse',
		respond: async ctx => {
			await ctx.write({ content: 'private original', flags: MessageFlags.Ephemeral });
			await ctx.editResponse({ content: 'private edited' });
		},
		owner: [['private edited', 'ephemeral']],
		other: [],
	},
	{
		name: 'an ephemeral followup after a public original is private',
		respond: async ctx => {
			await ctx.write({ content: 'public original' });
			await ctx.followup({ content: 'private followup', flags: MessageFlags.Ephemeral });
		},
		owner: [
			['public original', 'public'],
			['private followup', 'ephemeral'],
		],
		other: [['public original', 'public']],
	},
])('$name', async ({ respond, owner: ownerSees, other: otherSees }) => {
	const { world, guild, channel, owner, other } = visibilityFixture('visibility');
	@Declare({ name: 'respond', description: 'Respond' })
	class Respond extends Command {
		async run(ctx: CommandContext) {
			await respond(ctx);
		}
	}
	const bot = await createMockBot({ commands: [Respond], world });
	try {
		await bot.slash({ name: 'respond', user: owner.user, guildId: guild.id, channel });
		const seen = (userId: string) =>
			bot
				.conversation({ userId, channelId: channel.id })
				.messages.map(message => [message.payload.content, message.visibility]);
		expect(seen(owner.user.id)).toEqual(ownerSees);
		expect(seen(other.user.id)).toEqual(otherSees);
		const ephemeral = bot.inspectChannel(channel.id).messages.filter(message => message.visibility === 'ephemeral');
		for (const message of ephemeral) {
			expect(message).toMatchObject({ ownerId: owner.user.id, liveRecipientIds: [owner.user.id] });
		}
	} finally {
		await bot.close();
	}
});

test('a deferred reply is an owner-only loading placeholder until a followup fills it', async () => {
	const { world, guild, channel, owner, other } = visibilityFixture('loading');
	let bot: Awaited<ReturnType<typeof createMockBot>>;
	let ownerLoading: VisibleMessage[] = [];
	let otherLoading: VisibleMessage[] = [];
	@Declare({ name: 'deferred', description: 'Deferred reply' })
	class Deferred extends Command {
		async run(ctx: CommandContext) {
			await ctx.deferReply(true);
			ownerLoading = bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages;
			otherLoading = bot.conversation({ userId: other.user.id, channelId: channel.id }).messages;
			await ctx.followup({ content: 'done' });
		}
	}
	bot = await createMockBot({ commands: [Deferred], world });
	try {
		await bot.slash({ name: 'deferred', user: owner.user, guildId: guild.id, channel });
		expect(ownerLoading.map(message => message.payload.flags)).toEqual([MessageFlags.Ephemeral | MessageFlags.Loading]);
		expect(otherLoading).toEqual([]);
		expect(
			bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages.map(message => message.payload.flags),
		).toEqual([MessageFlags.Ephemeral]);
	} finally {
		await bot.close();
	}
});

test('deferred component update edits the source without changing its ephemeral owner', async () => {
	const { world, channel, owner, other } = visibilityFixture('update');
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

test('editing an ephemeral followup with flags: 0 keeps it private', async () => {
	const { world, guild, channel, owner, other } = visibilityFixture('edit-flags');
	@Declare({ name: 'private-followup', description: 'Private followup' })
	class PrivateFollowup extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'public original' });
			await ctx.followup({ content: 'private followup', flags: MessageFlags.Ephemeral });
		}
	}
	const bot = await createMockBot({ commands: [PrivateFollowup], world });
	try {
		const result = await bot.slash({ name: 'private-followup', user: owner.user, guildId: guild.id, channel });
		const followup = result.actions.find(action => action.route.includes('/webhooks/') && action.method === 'POST');
		const privateFollowup = bot
			.conversation({ userId: owner.user.id, channelId: channel.id })
			.messages.find(message => message.payload.content === 'private followup');
		if (!followup || !privateFollowup) throw new Error('expected private followup route and message');
		await bot.rest.request('PATCH', `${followup.route}/messages/${privateFollowup.id}` as `/${string}`, {
			body: { content: 'private followup edited', flags: 0 },
		});
		expect(
			bot
				.conversation({ userId: owner.user.id, channelId: channel.id })
				.messages.find(message => message.id === privateFollowup.id),
		).toMatchObject({ visibility: 'ephemeral', payload: { content: 'private followup edited' } });
		expect(contents(bot, other.user.id, channel.id)).toEqual(['public original']);
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
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['mine']);
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
		expect(contents(bot, bob.user.id, channel.id)).toEqual(['seed']);
		expect(bot.conversation({ userId: bob.user.id, channelId: denied.id }).diagnostics).toContain('history-hidden:1');
		expect(bot.conversation({ userId: alice.user.id, channelId: allowed.id }).messages).toHaveLength(1);
		expect(bot.conversation({ userId: carol.user.id, channelId: denied.id }).messages).toHaveLength(1);
		expect(bot.conversation({ userId: owner.user.id, channelId: denied.id }).messages).toHaveLength(1);
		expect(bot.inspectChannel(channel.id).messages).toMatchObject([
			{ id: 'history-seed', sequence: 1, isHistory: true },
			{ id: 'history-private', ownerId: alice.user.id, isHistory: true },
		]);
		await bot.rest.request('POST', `/channels/${channel.id}/messages`, { body: { content: 'live' } });
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['mine', 'live']);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['seed', 'mine', 'live']);
		await bot.admin.removeMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['mine', 'live']);
		expect(bot.conversation({ userId: alice.user.id, channelId: channel.id }).diagnostics).toContain(
			'history-hidden:1',
		);
		await bot.rest.request('PUT', `/channels/${channel.id}/permissions/${alice.user.id}`, {
			body: { type: 1, allow: PermissionFlagsBits.ReadMessageHistory.toString(), deny: '0' },
		});
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['seed', 'mine', 'live']);
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
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['edited live']);
		expect(contents(bot, bob.user.id, channel.id)).toEqual(['before view', 'edited live']);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: alice.user.id, roleId: read.id });
		expect(contents(bot, alice.user.id, channel.id)).toEqual(['before view', 'edited live']);
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
		expect(contents(bot, newcomer.id, channel.id)).toEqual(['after join']);
		expect(bot.inspectChannel(channel.id).messages.map(message => message.liveRecipientIds)).toEqual([
			[],
			[newcomer.id],
		]);
	} finally {
		await bot.close();
	}
});
