import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	createStringOption,
	Declare,
	ModalCommand,
	type ModalContext,
	Options,
	SubCommand,
} from 'seyfert';
import { assert, describe, expect, test } from 'vitest';
import {
	channelOption,
	idAge,
	mockChannel,
	mockClient,
	mockCommandContext,
	mockComponentContext,
	mockGuild,
	mockId,
	mockMember,
	mockMessage,
	mockModalContext,
	mockQueues,
	mockScene,
	mockScheduler,
	mockUser,
	resetMockIds,
	setupSlipherTesting,
	timestampFrom,
	userOption,
} from '../src';

describe('entity factories', () => {
	test('generate unique IDs by default', () => {
		resetMockIds();

		const first = mockUser();
		const second = mockUser();
		const guild = mockGuild();
		const channel = mockChannel();

		assert.notEqual(first.id, second.id);
		assert.notEqual(first.id, guild.id);
		assert.notEqual(guild.id, channel.id);
	});

	test('preserve explicit overrides', () => {
		const user = mockUser({ id: '1', username: 'socram', bot: true });
		const guild = mockGuild({ id: '2', name: 'Seyfert' });
		const channel = mockChannel({ id: '3', guildId: null });
		const member = mockMember({ user, roles: ['admin'], nick: 'Soc' });

		assert.equal(user.id, '1');
		assert.equal(user.username, 'socram');
		assert.equal(user.bot, true);
		assert.equal(guild.name, 'Seyfert');
		assert.equal(channel.guildId, null);
		assert.deepEqual(member.roles, ['admin']);
		assert.equal(member.nick, 'Soc');
	});

	test('preserve an explicit null globalName', () => {
		const user = mockUser({ username: 'socram', globalName: null });

		assert.equal(user.globalName, null);
		assert.equal(user.global_name, null);
	});

	test('factory outputs can be used directly as interaction option payloads', () => {
		const user = mockUser({ id: 'factory-user', username: 'socram', globalName: 'Socram' });
		const channel = mockChannel({ id: 'factory-channel', guildId: 'factory-guild' });
		const member = mockMember({ user, joinedAt: '2026-06-14T00:00:00.000Z' });

		const encodedUser = userOption(user);
		const encodedChannel = channelOption(channel);

		assert.equal(user.global_name, 'Socram');
		assert.equal(channel.guild_id, 'factory-guild');
		assert.equal(member.joined_at, '2026-06-14T00:00:00.000Z');
		assert.deepEqual(encodedUser.resolved?.users?.['factory-user'], user);
		const resolvedChannel = encodedChannel.resolved?.channels?.['factory-channel'] as
			| { guild_id?: string; permissions?: string }
			| undefined;
		assert.equal(resolvedChannel?.guild_id, 'factory-guild');
		assert.equal(typeof resolvedChannel?.permissions, 'string');
	});

	test('reject non-integer mock ID reset values before conversion', () => {
		assert.throws(() => resetMockIds(1.5), TypeError);
		assert.throws(() => resetMockIds('1.5'), TypeError);
		assert.throws(() => resetMockIds('abc'), TypeError);

		resetMockIds(' 42 ');

		assert.equal(mockUser().id, '661720242761760810');
	});
});

describe('time-aware mock ids', () => {
	test('mockId({ at }) round-trips through timestampFrom', () => {
		const at = new Date('2024-03-01T12:00:00.000Z');
		const id = mockId({ at });

		assert.equal(timestampFrom(id), at.getTime());
	});

	test('mockId({ age }) encodes a creation time that many ms ago', () => {
		const id = mockId({ age: '13d' });
		const thirteenDays = 13 * 24 * 60 * 60 * 1000;

		// within a generous window: age reads Date.now() at call + decode
		assert.ok(idAge(id) >= thirteenDays - 2000);
		assert.ok(idAge(id) <= thirteenDays + 2000);
	});

	test('time-pinned ids do not disturb the deterministic counter', () => {
		resetMockIds(42);
		mockId({ age: '7d' });
		mockId({ at: new Date('2024-01-01T00:00:00.000Z') });

		// plain mockId() is still byte-identical to seq 42
		assert.equal(mockUser().id, '661720242761760810');
	});

	test('ids pinned to the same instant stay distinct', () => {
		const at = new Date('2024-01-01T00:00:00.000Z');
		assert.notEqual(mockId({ at }), mockId({ at }));
	});

	test('mockId({ at }) rejects an unparseable date string', () => {
		assert.throws(() => mockId({ at: 'not-a-date' }), TypeError);
	});
});

describe('mockCommandContext', () => {
	test('captures responses in call order', async () => {
		const ctx = mockCommandContext({ commandName: 'ping', userId: '1', guildId: '2', channelId: '3' });

		await ctx.write({ content: 'pong' });
		await ctx.editOrReply({ content: 'edited' });
		await ctx.followup('done');

		assert.equal(ctx.command.name, 'ping');
		assert.equal(ctx.author.id, '1');
		assert.equal(ctx.guildId, '2');
		assert.equal(ctx.channelId, '3');
		assert.deepEqual(ctx.responses, [{ content: 'pong' }, { content: 'edited' }, 'done']);
		assert.equal(ctx.lastResponse(), 'done');
	});

	test('clears captured responses without depending on runner spies', async () => {
		const ctx = mockCommandContext();

		await ctx.write('hello');
		ctx.clearResponses();

		assert.deepEqual(ctx.responses, []);
		assert.equal(ctx.lastResponse(), undefined);
	});

	test('creates direct-message-like contexts without impossible guild state', () => {
		const member = mockMember();
		const ctx = mockCommandContext({ guild: null, guildId: '2', member });

		assert.equal(ctx.guildId, undefined);
		assert.equal(ctx.member, null);
		assert.equal(typeof ctx.guild, 'function');
		assert.equal(typeof ctx.channel, 'function');
	});

	test('guild and channel use Seyfert method shape', async () => {
		const guild = mockGuild({ id: 'guild-1' });
		const channel = mockChannel({ id: 'channel-1', guildId: guild.id });
		const ctx = mockCommandContext({ guild, channel });

		assert.equal(typeof ctx.guild, 'function');
		assert.equal(await ctx.guild(), guild);
		assert.equal(ctx.guild() instanceof Promise, true);
		assert.equal(typeof ctx.channel, 'function');
		assert.equal(await ctx.channel(), channel);
		assert.equal(ctx.channel() instanceof Promise, true);
	});

	test('guild method resolves null in direct-message-like contexts', async () => {
		const ctx = mockCommandContext({ guild: null });

		assert.equal(await ctx.guild(), null);
		assert.equal(ctx.guildId, undefined);
		assert.equal(ctx.member, null);
		assert.equal((await ctx.channel()).guildId, null);
	});

	test('provides integration stubs for logger, queues, and scheduler', async () => {
		const ctx = mockCommandContext();

		ctx.logger.add({ command: 'ping' });
		ctx.logger.info('ran');
		await ctx.queues.get('welcome').add('send', { userId: ctx.author.id }, { delay: '5s' });
		ctx.scheduler.add('reminder', '30m', () => undefined);

		assert.deepEqual(ctx.logger.entries.at(-1), { level: 'info', args: ['ran'] });
		assert.deepEqual(ctx.logger.currentContext, { command: 'ping' });
		assert.equal(ctx.queues.get('welcome').jobs.at(-1)?.name, 'send');
		assert.deepEqual(ctx.queues.get('welcome').jobs.at(-1)?.payload, { userId: ctx.author.id });
		assert.equal(ctx.scheduler.tasks.at(-1)?.name, 'reminder');
	});

	test('provides a minimal client with shared Slipher stubs', async () => {
		const ctx = mockCommandContext();

		ctx.client.logger.info('through-client');
		await ctx.client.queues.get('welcome').add({ userId: ctx.author.id });
		ctx.client.scheduler.add('reminder', '30m', () => undefined);

		assert.equal(ctx.client.logger, ctx.logger);
		assert.equal(ctx.client.queues, ctx.queues);
		assert.equal(ctx.client.scheduler, ctx.scheduler);
		assert.deepEqual(ctx.logger.entries.at(-1), { level: 'info', args: ['through-client'] });
		assert.deepEqual(ctx.queues.get('welcome').jobs.at(-1)?.payload, { userId: ctx.author.id });
		assert.equal(ctx.scheduler.tasks.at(-1)?.name, 'reminder');
	});

	test('mockCommandContext(Command) infers typed options + name; ctx.run() executes it', async () => {
		const banOptions = { reason: createStringOption({ description: 'why', required: true }) };
		@Declare({ name: 'ban', description: 'bans a user' })
		@Options(banOptions)
		class BanCommand extends Command {
			async run(ctx: CommandContext<typeof banOptions>) {
				await ctx.editOrReply({ content: `Banned: ${ctx.options.reason}` });
			}
		}

		const ctx = mockCommandContext(BanCommand, { options: { reason: 'spam' } }); // options.reason autocompleted/typed
		await ctx.run(); // no argument — the command is bound at creation

		expect(ctx.command.name).toBe('ban'); // derived from @Declare, not the 'test' default
		expect(ctx.lastResponse()).toMatchObject({ content: 'Banned: spam' });
	});

	test('mockCommandContext(SubCommand) is accepted (SubCommand is a sibling of Command) and infers options', async () => {
		const listOptions = { page: createStringOption({ description: 'page', required: true }) };
		@Declare({ name: 'list', description: 'lists items' })
		@Options(listOptions)
		class ListSub extends SubCommand {
			async run(ctx: CommandContext<typeof listOptions>) {
				await ctx.editOrReply({ content: `page ${ctx.options.page}` });
			}
		}

		const ctx = mockCommandContext(ListSub, { options: { page: '2' } }); // typed options on a SubCommand
		await ctx.run();

		expect(ctx.command.name).toBe('list');
		expect(ctx.lastResponse()).toMatchObject({ content: 'page 2' });
	});

	test('ctx.run() surfaces errors thrown by the bound command', async () => {
		@Declare({ name: 'boom', description: 'throws' })
		class BoomCommand extends Command {
			async run() {
				throw new Error('boom');
			}
		}

		const ctx = mockCommandContext(BoomCommand);
		await expect(ctx.run()).rejects.toThrow('boom');
	});

	test('ctx.run() runs a bound command whose run() takes an extra parameter', async () => {
		// Guards any-arity: a command whose run() has a second (optional) param still binds + runs. A REQUIRED
		// second param can't override Command.run(ctx) — seyfert commands are 1-arg by contract — so optional is
		// the only valid shape here, and it must stay assignable.
		@Declare({ name: 'meta', description: 'extra run param' })
		class WithMetadata extends Command {
			async run(ctx: CommandContext, _metadata?: { requestId: string }) {
				await ctx.editOrReply({ content: 'ok' });
			}
		}

		const ctx = mockCommandContext(WithMetadata);
		await ctx.run();

		expect(ctx.lastResponse()).toMatchObject({ content: 'ok' });
	});

	test('ctx.run() throws when the context was built without a command (object form)', async () => {
		const ctx = mockCommandContext({ commandName: 'sink' });
		await expect(ctx.run()).rejects.toThrow(/no command bound/);
	});

	test('mockComponentContext(ComponentClass) derives componentType/customId and binds run()', async () => {
		const seen: string[] = [];
		class ConfirmButton extends ComponentCommand {
			componentType = 'Button' as const;
			customId = 'confirm';
			async run(ctx: ComponentContext<'Button'>) {
				seen.push(ctx.customId);
				await ctx.write({ content: 'clicked' });
			}
		}

		const ctx = mockComponentContext(ConfirmButton);
		expect(ctx.componentType).toBe('Button'); // derived from the class
		expect(ctx.customId).toBe('confirm');
		await ctx.run();

		expect(seen).toEqual(['confirm']);
		expect(ctx.lastResponse()).toMatchObject({ content: 'clicked' });
	});

	test('mockModalContext(ModalClass) derives customId and binds run()', async () => {
		const seen: string[] = [];
		class FeedbackModal extends ModalCommand {
			customId = 'feedback';
			async run(ctx: ModalContext) {
				seen.push(ctx.customId);
				await ctx.write({ content: 'submitted' });
			}
		}

		const ctx = mockModalContext(FeedbackModal);
		expect(ctx.customId).toBe('feedback');
		await ctx.run();

		expect(seen).toEqual(['feedback']);
		expect(ctx.lastResponse()).toMatchObject({ content: 'submitted' });
	});

	test('asComponentContext()/asModalContext() feed a command filter/run directly', () => {
		class GatedButton extends ComponentCommand {
			componentType = 'Button' as const;
			filter(ctx: ComponentContext<'Button'>) {
				return ctx.customId === 'go';
			}
			async run() {}
		}
		class GatedModal extends ModalCommand {
			filter(ctx: ModalContext) {
				return ctx.customId === 'form';
			}
			async run() {}
		}

		const button = new GatedButton();
		// The point: the mock is accepted where a seyfert ComponentContext is required, no `as unknown` in the test.
		expect(button.filter(mockComponentContext({ customId: 'go' }).asComponentContext())).toBe(true);
		expect(button.filter(mockComponentContext({ customId: 'nope' }).asComponentContext())).toBe(false);

		const modal = new GatedModal();
		expect(modal.filter(mockModalContext({ customId: 'form' }).asModalContext())).toBe(true);
	});

	test('mockScene(Command) wires entities + a class-bound, typed-options ctx', async () => {
		const banOptions = { reason: createStringOption({ description: 'why', required: true }) };
		@Declare({ name: 'ban', description: 'bans' })
		@Options(banOptions)
		class BanCommand extends Command {
			async run(ctx: CommandContext<typeof banOptions>) {
				await ctx.editOrReply({ content: `Banned ${ctx.options.reason}` });
			}
		}

		const scene = mockScene(BanCommand, { options: { reason: 'spam' }, guildId: '42' });
		expect(scene.guild?.id).toBe('42');
		await scene.ctx.run();

		expect(scene.ctx.command.name).toBe('ban');
		expect(scene.ctx.lastResponse()).toMatchObject({ content: 'Banned spam' });
	});
});

describe('standalone interaction contexts', () => {
	test('mockComponentContext captures writes, updates and deferUpdate calls', async () => {
		const ctx = mockComponentContext({ customId: 'confirm', values: ['a', 'b'] });

		await ctx.write({ content: 'created' });
		await ctx.update({ content: 'updated' });
		await ctx.deferUpdate();

		assert.equal(ctx.customId, 'confirm');
		assert.deepEqual(ctx.interaction.values, ['a', 'b']);
		assert.deepEqual(ctx.responses, [{ content: 'created' }, { content: 'updated' }]);
		assert.equal(ctx.deferredUpdate, true);
	});

	test('mockModalContext exposes submitted fields through getInputValue', async () => {
		const ctx = mockModalContext({ customId: 'profile', fields: { username: 'neo' } });

		await ctx.write({ content: ctx.interaction.getInputValue('username', true) });

		assert.equal(ctx.customId, 'profile');
		assert.equal(ctx.interaction.getInputValue('username'), 'neo');
		assert.throws(() => ctx.interaction.getInputValue('missing', true), /missing/);
		assert.deepEqual(ctx.responses, [{ content: 'neo' }]);
	});
});

describe('standalone stubs', () => {
	test('mockQueues returns stable named queues', async () => {
		const queues = mockQueues();
		const first = queues.get('email');
		const second = queues.get('email');

		await first.add('send', { to: 'a@example.com' });

		assert.equal(first, second);
		assert.equal(second.jobs.length, 1);
		assert.equal(second.jobs[0]?.name, 'send');
	});

	test('mockQueues rejects ambiguous string payload plus options-shaped data', async () => {
		const queue = mockQueues().get('email');

		await expect(queue.add('send', { delay: '5s' })).rejects.toThrow(/Ambiguous queue\.add\(\) call/);

		const job = await queue.add('send', { delay: '5s' }, {});

		assert.equal(job.name, 'send');
		assert.deepEqual(job.payload, { delay: '5s' });
	});

	test('mockScheduler records dynamic tasks', () => {
		const scheduler = mockScheduler();
		const task = scheduler.add('heartbeat', '5m', () => undefined);

		assert.equal(task.name, 'heartbeat');
		assert.equal(scheduler.tasks.length, 1);
	});

	test('mockClient defaults and explicit overrides are reachable', () => {
		const queues = mockQueues();
		const client = mockClient({ queues, botId: 'bot-1', applicationId: 'app-1', extra: { custom: 1 } });

		assert.equal(client.queues, queues);
		assert.equal(client.botId, 'bot-1');
		assert.equal(client.applicationId, 'app-1');
		assert.equal(client.custom, 1);
		assert.ok(client.logger);
		assert.ok(client.scheduler);
	});
});

describe('Phase-4a additions', () => {
	test('mockMessage mirrors camelCase/snake_case and defaults', () => {
		const m = mockMessage({ channelId: 'chan-1', guildId: 'guild-1', content: 'hi' });
		assert.equal(m.channelId, 'chan-1');
		assert.equal(m.channel_id, 'chan-1');
		assert.equal(m.guildId, 'guild-1');
		assert.equal(m.guild_id, 'guild-1');
		assert.equal(m.content, 'hi');
		assert.ok(m.author.id);
		assert.deepEqual(m.embeds, []);
	});

	test('mockMessage omits guild fields for a DM message', () => {
		const m = mockMessage({ guildId: null });
		assert.equal('guildId' in m, false);
		assert.equal('guild_id' in m, false);
	});

	test('mockScene wires channel to guild and member to user', () => {
		const scene = mockScene({ options: { foo: 1 } });
		assert.equal(scene.channel.guildId, scene.guild?.id);
		assert.equal(scene.member?.user, scene.user);
		assert.equal(scene.ctx.author, scene.user);
		assert.deepEqual(scene.ctx.options, { foo: 1 });
	});

	test('mockScene with guild: null yields a DM scene (no member)', () => {
		const scene = mockScene({ guild: null });
		assert.equal(scene.guild, null);
		assert.equal(scene.member, null);
		assert.equal(scene.channel.guildId, null);
	});

	test('setupSlipherTesting registers a beforeEach that resets ids; no-op without a runner hook', () => {
		const original = (globalThis as { beforeEach?: unknown }).beforeEach;
		try {
			let registered: (() => void) | undefined;
			(globalThis as { beforeEach?: (fn: () => void) => void }).beforeEach = fn => {
				registered = fn;
			};
			setupSlipherTesting();
			assert.equal(typeof registered, 'function');

			// the registered hook resets ids to the deterministic start
			resetMockIds();
			const firstAtStart = mockUser().id;
			resetMockIds(500);
			mockUser(); // advance the sequence
			registered?.(); // what beforeEach would run -> resetMockIds()
			assert.equal(mockUser().id, firstAtStart);

			// no-op when no hook is present
			(globalThis as { beforeEach?: unknown }).beforeEach = undefined;
			assert.doesNotThrow(() => setupSlipherTesting());
		} finally {
			(globalThis as { beforeEach?: unknown }).beforeEach = original;
		}
	});
});
