import { AttachmentBuilder, Command, type CommandContext, Declare } from 'seyfert';
import { describe, expect, test } from 'vitest';
import { createMockBot } from '../../src/bot/bot';
import { apiUser } from '../../src/bot/payloads';
import { mockWorld } from '../../src/bot/world';

describe('message attachments', () => {
	test('a command attaching a file lands the attachment metadata in the message view', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'att-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'att-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'att-chan' });

		@Declare({ name: 'upload', description: 'attaches a file' })
		class Upload extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.write(channel.id, {
					content: 'see file',
					files: [new AttachmentBuilder().setName('report.pdf').setFile('buffer', Buffer.from('x'))],
				});
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [Upload], world });
		await bot.slash({ name: 'upload', guildId: guild.id, channel, user: actor.user });
		const sent = bot
			.cachedGuild(guild.id)
			?.channel('att-chan')
			?.messages.find(message => message.content === 'see file');
		expect(sent?.attachments).toHaveLength(1);
		expect(sent?.attachments[0]).toMatchObject({ filename: 'report.pdf' });
		expect(sent?.attachments[0]?.url).toBeDefined();
		await bot.close();
	});

	test('editing attachments replaces the retained set', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'att-edit-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'att-edit-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'att-edit-chan' });

		@Declare({ name: 'reupload', description: 'attaches then clears' })
		class Reupload extends Command {
			async run(ctx: CommandContext) {
				const msg = await ctx.client.messages.write(channel.id, {
					files: [new AttachmentBuilder().setName('a.png').setFile('buffer', Buffer.from('x'))],
				});
				await ctx.client.messages.edit(msg.id, channel.id, { attachments: [] });
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [Reupload], world });
		await bot.slash({ name: 'reupload', guildId: guild.id, channel, user: actor.user });
		const messages = bot.cachedGuild(guild.id)?.channel('att-edit-chan')?.messages ?? [];
		const edited = messages.find(message => message.attachments.length === 0 && message.content === '');
		expect(edited).toBeDefined();
		await bot.close();
	});
});

describe('message references (replies and forwards)', () => {
	test('a reply records the reference and resolves the referenced message', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'ref-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'ref-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'ref-chan' });
		world.registerMessage(channel.id, { id: 'target-msg', content: 'original' });

		@Declare({ name: 'reply', description: 'replies to a message' })
		class Reply extends Command {
			async run(ctx: CommandContext) {
				await ctx.client.messages.write(channel.id, {
					content: 'replying',
					message_reference: { message_id: 'target-msg', channel_id: channel.id },
				});
				await ctx.write({ content: 'done' });
			}
		}

		const bot = await createMockBot({ commands: [Reply], world });
		await bot.slash({ name: 'reply', guildId: guild.id, channel, user: actor.user });
		const reply = bot
			.cachedGuild(guild.id)
			?.channel('ref-chan')
			?.messages.find(message => message.content === 'replying');
		expect(reply?.reference?.messageId).toBe('target-msg');
		expect(reply?.referencedMessage?.content).toBe('original');
		await bot.close();
	});

	test('a forward records a snapshot of the referenced message', async () => {
		const world = mockWorld();
		const guild = world.registerGuild({ id: 'fwd-guild' });
		const actor = world.registerMember(guild.id, { user: apiUser({ id: 'fwd-actor' }) });
		const channel = world.registerChannel(guild.id, { id: 'fwd-chan' });
		world.registerMessage(channel.id, { id: 'fwd-target', content: 'forward me' });

		@Declare({ name: 'forward', description: 'forwards a message' })
		class Forward extends Command {
			async run(ctx: CommandContext) {
				const sent = await ctx.client.messages.write(channel.id, {
					message_reference: { type: 1, message_id: 'fwd-target', channel_id: channel.id },
				});
				await ctx.write({ content: sent.id });
			}
		}

		const bot = await createMockBot({ commands: [Forward], world });
		const res = await bot.slash({ name: 'forward', guildId: guild.id, channel, user: actor.user });
		const snapshot = bot.state.rawMessage(channel.id, res.content ?? '') as
			| { reference?: unknown; message_snapshots?: { message: { content?: string } }[] }
			| undefined;
		const view = bot
			.cachedGuild(guild.id)
			?.channel('fwd-chan')
			?.messages.find(message => message.id === res.content);
		expect(view?.reference?.type).toBe(1);
		expect(snapshot?.message_snapshots?.[0]?.message.content).toBe('forward me');
		await bot.close();
	});
});
