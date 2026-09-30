import { join } from 'node:path';
import {
	ActionRow,
	Button,
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	createEvent,
	createStringOption,
	Declare,
	Group,
	Groups,
	Label,
	MessageFlags,
	Modal,
	Options,
	SubCommand,
	TextInput,
} from 'seyfert';
import { ButtonStyle, TextInputStyle } from 'seyfert/lib/types';
import { expect, test, vi } from 'vitest';
import { createMockBot, type MockBotEvent, rendered } from '../../src';
import { apiUser } from '../../src/bot/payloads';
import { DiscordErrors } from '../../src/bot/rest';
import { mockWorld } from '../../src/bot/world';
import { expectDiscordError } from './_setup';

test('conversation filters channel access and ephemeral ownership while preserving response identity', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'lab-visibility', everyonePermissions: ['ViewChannel', 'SendMessages'] });
	const access = world.registerRole(guild.id, { id: 'lab-access', permissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id, {
		id: 'lab-private',
		overwrites: [
			{ id: guild.id, type: 'role', deny: ['ViewChannel'] },
			{ id: access.id, type: 'role', allow: ['ViewChannel'] },
		],
	});
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'lab-owner' }), roles: [access.id] });
	const viewer = world.registerMember(guild.id, { user: apiUser({ id: 'lab-viewer' }), roles: [access.id] });
	const excluded = world.registerMember(guild.id, { user: apiUser({ id: 'lab-excluded' }) });

	@Declare({ name: 'lab-post', description: 'Post a thread' })
	class Post extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'original' });
			await ctx.editResponse({ content: 'edited' });
			await ctx.followup({ content: 'private followup', flags: MessageFlags.Ephemeral });
		}
	}
	@Declare({ name: 'lab-secret', description: 'Post a private original' })
	class Secret extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'private original', flags: MessageFlags.Ephemeral });
		}
	}
	const bot = await createMockBot({ commands: [Post, Secret], world });
	try {
		const actorSession = bot.actor({ user: owner.user, guildId: guild.id, channel });
		const posted = await actorSession.slash({ name: 'lab-post' });
		const owned = bot.conversation({ userId: owner.user.id, channelId: channel.id });
		const other = bot.conversation({ userId: viewer.user.id, channelId: channel.id });
		expect(owned.messages.map(message => message.payload.content)).toEqual(['edited', 'private followup']);
		expect(owned.messages[0].editedAt).toBeDefined();
		expect(owned.messages[0].ownerId).toBe(owner.user.id);
		expect(owned.messages[0].interactionId).toBeDefined();
		expect(other.messages.map(message => message.payload.content)).toEqual(['edited']);
		expect(other.diagnostics).not.toContain('history-hidden');
		expect(bot.conversation({ userId: excluded.user.id, channelId: channel.id })).toMatchObject({
			messages: [],
			diagnostics: ['no-view-channel'],
		});
		const originalId = owned.messages[0].id;
		const followupId = owned.messages[1].id;
		const editRoute = posted.actions.find(action => action.route.includes('/messages/@original'))?.route;
		if (!editRoute) throw new Error('expected @original edit route');
		await bot.rest.request('PATCH', editRoute.replace('@original', followupId) as `/${string}`, {
			body: { content: 'private updated' },
		});
		expect(
			bot
				.conversation({ userId: owner.user.id, channelId: channel.id })
				.messages.find(message => message.id === followupId),
		).toMatchObject({ visibility: 'ephemeral', ownerId: owner.user.id, payload: { content: 'private updated' } });
		await bot.rest.request('DELETE', editRoute as `/${string}`);
		expect(
			bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages.map(message => message.id),
		).not.toContain(originalId);
		expect(bot.inspectChannel(channel.id).messages.find(message => message.id === originalId)).toMatchObject({
			deleted: true,
			payload: { content: 'edited' },
		});
		await actorSession.slash({ name: 'lab-secret' });
		expect(
			bot
				.conversation({ userId: owner.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).toContain('private original');
		expect(
			bot
				.conversation({ userId: viewer.user.id, channelId: channel.id })
				.messages.map(message => message.payload.content),
		).not.toContain('private original');
		// Conversation is cumulative; rendered(actor) remains scoped to the latest step.
		rendered(actorSession).get.message({ content: 'private original' });
		expect(rendered(actorSession).query.message({ content: 'edited' })).toBeUndefined();
	} finally {
		await bot.close();
	}
});

test('seeded ephemeral views enforce channel access while component actions only enforce known ownership', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'seeded-private-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'seeded-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'seeded-other' }) });
	const excluded = world.registerMember(guild.id, { user: apiUser({ id: 'seeded-excluded' }) });
	const restricted = world.registerChannel(guild.id, {
		id: 'seeded-restricted-channel',
		overwrites: [{ id: guild.id, type: 'role', deny: ['ViewChannel'] }],
	});
	const missing = world.registerChannel(guild.id, { id: 'seeded-unregistered-channel' });
	const components = [
		{ type: 1, components: [{ type: 2, style: 1, custom_id: 'seeded-click', label: 'Open' }] },
		{
			type: 1,
			components: [
				{
					type: 3,
					custom_id: 'seeded-select',
					options: [{ label: 'One', value: 'one' }],
				},
			],
		},
	];
	world.registerMessage(channel.id, {
		id: 'owned-private-panel',
		ownerId: owner.user.id,
		flags: MessageFlags.Ephemeral,
		components,
	});
	world.registerMessage(channel.id, {
		id: 'leaderboard-message',
		flags: MessageFlags.Ephemeral,
		components,
	});
	world.registerMessage(channel.id, {
		id: 'second-unknown-owner',
		flags: MessageFlags.Ephemeral,
	});
	world.registerMessage(restricted.id, {
		id: 'restricted-private-panel',
		flags: MessageFlags.Ephemeral,
		components,
	});
	world.registerMessage(missing.id, {
		id: 'unregistered-private-panel',
		flags: MessageFlags.Ephemeral,
		components,
	});
	// A legacy fixture can contain a message without registering its channel in the world.
	world.build().channels.splice(world.build().channels.indexOf(missing), 1);
	class SeededButton extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'seeded-click';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.write({ content: 'opened' });
		}
	}
	class SeededSelect extends ComponentCommand {
		componentType = 'StringSelect' as const;
		customId = 'seeded-select';
		async run(ctx: ComponentContext<'StringSelect'>) {
			await ctx.write({ content: 'selected' });
		}
	}
	const bot = await createMockBot({ components: [SeededButton, SeededSelect], world });
	try {
		const ownerActor = bot.actor({ member: owner, guildId: guild.id, channel });
		const otherActor = bot.actor({ member: other, guildId: guild.id, channel });
		const excludedActor = bot.actor({ member: excluded, guildId: guild.id, channel: restricted });
		const ownerView = bot.conversation({ userId: owner.user.id, channelId: channel.id });
		const otherView = bot.conversation({ userId: other.user.id, channelId: channel.id });
		expect(ownerView.messages.map(message => message.id)).toEqual(['owned-private-panel']);
		expect(otherView.messages.map(message => message.id)).toEqual([]);
		expect(ownerView.diagnostics).toContain('ephemeral-owner-unknown:2-hidden');
		expect(otherView.diagnostics).toContain('ephemeral-owner-unknown:2-hidden');
		expect(bot.inspectChannel(channel.id).diagnostics).toContain('ephemeral-owner-unknown');
		expect(bot.inspectChannel(channel.id).messages).toMatchObject([
			{ id: 'owned-private-panel', ownerId: owner.user.id },
			{ id: 'leaderboard-message' },
			{ id: 'second-unknown-owner' },
		]);
		expect(bot.conversation({ userId: excluded.user.id, channelId: restricted.id })).toMatchObject({
			messages: [],
			diagnostics: ['no-view-channel'],
		});
		expect(bot.conversation({ userId: owner.user.id, channelId: missing.id })).toMatchObject({
			messages: [],
			diagnostics: ['unknown-channel'],
		});
		expect(await excludedActor.clickButton('seeded-click', { source: 'restricted-private-panel' })).toMatchObject({
			content: 'opened',
		});
		expect(
			await excludedActor.selectMenu('seeded-select', ['one'], { source: 'restricted-private-panel' }),
		).toMatchObject({ content: 'selected' });
		expect(await ownerActor.clickButton('seeded-click', { source: 'unregistered-private-panel' })).toMatchObject({
			content: 'opened',
		});
		expect(await ownerActor.clickButton('seeded-click', { source: 'owned-private-panel' })).toMatchObject({
			content: 'opened',
		});
		await expect(otherActor.clickButton('seeded-click', { source: 'owned-private-panel' })).rejects.toThrow(
			/ephemeral source message "owned-private-panel" is visible only to its owner/,
		);
		await expect(otherActor.selectMenu('seeded-select', ['one'], { source: 'owned-private-panel' })).rejects.toThrow(
			/ephemeral source message "owned-private-panel" is visible only to its owner/,
		);
		// Existing Clippy fixtures seed an ephemeral source without owner metadata.
		expect(await otherActor.clickButton('seeded-click', { source: 'leaderboard-message' })).toMatchObject({
			content: 'opened',
		});
	} finally {
		await bot.close();
	}
});

test('admin role changes preserve member data, cache and event semantics, and change bot REST permissions', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'lab-roles', ownerId: 'lab-owner' });
	const manage = world.registerRole(guild.id, { id: 'lab-manage', permissions: ['ManageRoles'], position: 10 });
	const assigned = world.registerRole(guild.id, { id: 'lab-assigned', position: 1 });
	const other = world.registerGuild({ id: 'lab-other' });
	const foreign = world.registerRole(other.id, { id: 'lab-foreign' });
	const target = world.registerMember(guild.id, {
		user: apiUser({ id: 'lab-target' }),
		nick: 'kept',
		joinedAt: '2020-01-01T00:00:00.000Z',
	});
	target.flags = 17;
	world.registerBotMember(guild.id);
	let updates = 0;
	const updated = createEvent({
		data: { name: 'guildMemberUpdate' },
		run: () => {
			updates++;
		},
	});
	const bot = await createMockBot({ world, events: [updated] });
	try {
		await expect(
			bot.admin.addMemberRole({ guildId: guild.id, userId: target.user.id, roleId: foreign.id }),
		).rejects.toThrow(/not in guild/);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: target.user.id, roleId: assigned.id });
		const actual = bot.world.query.member({ guildId: guild.id, userId: target.user.id });
		const cached = await bot.client.cache.members?.raw(target.user.id, guild.id);
		expect(actual?.roles).toContain(assigned.id);
		expect(actual?.nick).toBe('kept');
		expect(cached?.roles).toContain(assigned.id);
		expect(cached?.nick).toBe('kept');
		expect(cached?.joined_at).toBe(target.joined_at);
		expect(cached?.flags).toBe(17);
		expect(updates).toBe(1);
		await expectDiscordError(
			bot.rest.request('PUT', `/guilds/${guild.id}/members/${target.user.id}/roles/${assigned.id}`),
			DiscordErrors.MissingPermissions,
		);
		await bot.admin.addMemberRole({ guildId: guild.id, userId: bot.client.botId, roleId: manage.id });
		await bot.admin.removeMemberRole({ guildId: guild.id, userId: target.user.id, roleId: assigned.id });
		expect(bot.world.query.member({ guildId: guild.id, userId: target.user.id })?.roles).not.toContain(assigned.id);
		expect((await bot.client.cache.members?.raw(target.user.id, guild.id))?.roles).not.toContain(assigned.id);
		await bot.rest.request('PUT', `/guilds/${guild.id}/members/${target.user.id}/roles/${assigned.id}`);
		expect(bot.world.query.member({ guildId: guild.id, userId: target.user.id })?.roles).toContain(assigned.id);
		expect((await bot.client.cache.members?.raw(target.user.id, guild.id))?.roles).toContain(assigned.id);
	} finally {
		await bot.close();
	}
});

test('observers see REST, world changes and a button modal; pending state clears on submit', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'lab-flow' });
	const channel = world.registerChannel(guild.id);
	const actor = world.registerMember(guild.id, { user: apiUser({ id: 'lab-actor' }) });
	@Declare({ name: 'lab-panel', description: 'Open a modal' })
	class Panel extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({
				content: 'panel',
				components: [
					new ActionRow().setComponents([
						new Button().setCustomId('lab-open').setLabel('Open').setStyle(ButtonStyle.Primary),
					]),
				],
			});
		}
	}
	class Open extends ComponentCommand {
		componentType = 'Button' as const;
		filter(ctx: ComponentContext<'Button'>) {
			return ctx.customId === 'lab-open';
		}
		async run(ctx: ComponentContext<'Button'>) {
			const submit = await ctx.interaction.modal(
				new Modal()
					.setCustomId('lab-modal')
					.setTitle('Lab modal')
					.setComponents([
						new Label()
							.setLabel('Value')
							.setComponent(new TextInput({ custom_id: 'value', style: TextInputStyle.Short })),
					]),
				{ waitFor: 2000 },
			);
			if (submit) await submit.write({ content: 'submitted' });
		}
	}
	const bot = await createMockBot({ commands: [Panel], components: [Open], world });
	const events: MockBotEvent[] = [];
	const unsubscribe = bot.observe(event => events.push(event));
	const bad = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const unsubscribeBad = bot.observe(() => {
		throw new Error('observer failed');
	});
	try {
		await bot.slash({ name: 'lab-panel', guildId: guild.id, channel, user: actor.user });
		expect(bot.pendingInteractions().collectors).toEqual([]);
		await bot.clickButton('lab-open', { guildId: guild.id, channel, user: actor.user });
		const [modal] = bot.pendingInteractions().modals;
		expect(modal).toMatchObject({
			userId: actor.user.id,
			customId: 'lab-modal',
			source: { messageId: expect.any(String), customId: 'lab-open' },
			payload: { custom_id: 'lab-modal', title: 'Lab modal', components: expect.any(Array) },
		});
		expect(modal.interactionId).toBeTruthy();
		await bot.submitModal('lab-modal', { value: 'ok' }, { user: actor.user });
		expect(bot.pendingInteractions().modals).toEqual([]);
		expect(events.some(event => event.type === 'rest' && event.phase === 'request')).toBe(true);
		expect(events.some(event => event.type === 'rest' && event.phase === 'settled')).toBe(true);
		expect(
			events.some(
				event => event.type === 'world' && event.diff.messages.added.some(message => message.content === 'submitted'),
			),
		).toBe(true);
		expect(
			events.some(
				event => event.type === 'interaction' && event.change.kind === 'modal' && event.change.phase === 'opened',
			),
		).toBe(true);
		expect(events.some(event => event.type === 'dispatch' && event.phase === 'end')).toBe(true);
		const count = events.length;
		unsubscribe();
		await bot.slash({ name: 'lab-panel', guildId: guild.id, channel, user: actor.user });
		expect(events).toHaveLength(count);
		expect(bad).toHaveBeenCalled();
	} finally {
		unsubscribeBad();
		bad.mockRestore();
		await bot.close();
	}
});

test('pendingInteractions lists a live message collector and removes it on stop', async () => {
	let stopCollector: (() => void) | undefined;
	@Declare({ name: 'lab-collect', description: 'Wait for a button' })
	class Collect extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({
				content: 'choose',
				components: [
					new ActionRow().setComponents([
						new Button().setCustomId('lab-choice').setLabel('Choose').setStyle(ButtonStyle.Primary),
					]),
				],
			});
			const message = await ctx.fetchResponse();
			const collector = message.createComponentCollector();
			collector.run('lab-choice', async interaction => {
				await interaction.write({ content: 'chosen' });
			});
			stopCollector = () => collector.stop();
		}
	}
	const bot = await createMockBot({ commands: [Collect] });
	const changes: string[] = [];
	const unsubscribe = bot.observe(event => {
		if (event.type === 'interaction' && event.change.kind === 'collector') changes.push(event.change.phase);
	});
	try {
		await bot.slash({ name: 'lab-collect' });
		expect(bot.pendingInteractions().collectors).toMatchObject([
			{
				messageId: expect.any(String),
				channelId: expect.any(String),
				kind: 'run',
				customIds: ['lab-choice'],
			},
		]);
		stopCollector?.();
		expect(bot.pendingInteractions().collectors).toEqual([]);
		await bot.slash({ name: 'lab-collect' });
		expect(bot.pendingInteractions().collectors).toHaveLength(1);
		await bot.reset();
		expect(bot.pendingInteractions().collectors).toEqual([]);
		expect(changes).toEqual(['opened', 'closed', 'opened', 'closed']);
	} finally {
		unsubscribe();
		await bot.close();
	}
});

test('a collector continuation exposes its modal with the opening interaction identity', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'collector-modal-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const actor = world.registerMember(guild.id, { user: apiUser({ id: 'collector-modal-user' }) });
	@Declare({ name: 'join-flow', description: 'Join flow' })
	class Join extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({
				content: 'Join',
				components: [
					new ActionRow<Button>().setComponents(
						new Button().setCustomId('join-flow-button').setLabel('Join').setStyle(ButtonStyle.Primary),
					),
				],
			});
		}
	}
	class OpenTos extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'join-flow-button';
		async run(ctx: ComponentContext<'Button'>) {
			const tos = await ctx.write(
				{
					content: 'Terms',
					components: [
						new ActionRow<Button>().setComponents(
							new Button().setCustomId('agree-tos').setLabel('Agree').setStyle(ButtonStyle.Primary),
						),
					],
				},
				true,
			);
			const agreed = await tos.createComponentCollector().waitFor('agree-tos');
			if (!agreed) return;
			await agreed.modal(
				new Modal()
					.setCustomId('tos-details')
					.setTitle('Details')
					.setComponents([
						new Label()
							.setLabel('Name')
							.setComponent(new TextInput({ custom_id: 'name', style: TextInputStyle.Short })),
					])
					.run(async submit => {
						if (!submit) return;
						await submit.write({ content: 'joined', flags: MessageFlags.Ephemeral });
						await submit.followup({ content: 'welcome', flags: MessageFlags.Ephemeral });
					}),
			);
		}
	}
	const bot = await createMockBot({ commands: [Join], components: [OpenTos], world });
	const events: MockBotEvent[] = [];
	bot.observe(event => events.push(event));
	try {
		await bot.slash({ name: 'join-flow', guildId: guild.id, channel, user: actor.user });
		const join = bot.conversation({ userId: actor.user.id, channelId: channel.id }).messages.at(-1);
		expect(join?.payload.content).toBe('Join');
		await bot.clickButton('join-flow-button', { guildId: guild.id, channel, user: actor.user, source: join?.id });
		const tos = bot.conversation({ userId: actor.user.id, channelId: channel.id }).messages.at(-1);
		expect(tos?.payload.content).toBe('Terms');
		expect(bot.pendingInteractions().collectors).toHaveLength(1);
		const before = bot.restCalls().length;
		await bot.clickButton('agree-tos', { guildId: guild.id, channel, user: actor.user, source: tos?.id });
		const modalCallback = bot
			.restCalls()
			.slice(before)
			.find(action => action.body?.type === 9);
		const callbackId = modalCallback?.route.match(/^\/interactions\/([^/]+)\//)?.[1];
		expect(callbackId).toBeTruthy();
		const [pending] = bot.pendingInteractions().modals;
		expect(bot.pendingInteractions().collectors).toEqual([]);
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'dispatch', phase: 'end', dispatchId: modalCallback?.dispatchId }),
		);
		expect(bot.pendingInteractions().modals).toHaveLength(1);
		expect(pending).toMatchObject({
			userId: actor.user.id,
			interactionId: callbackId,
			customId: 'tos-details',
			source: { messageId: tos?.id, customId: 'agree-tos' },
		});
		expect(pending.payload).toEqual(modalCallback?.body?.data);
		await bot.submitModal('tos-details', { name: 'Alice' }, { guildId: guild.id, channel, user: actor.user });
		expect(bot.pendingInteractions().modals).toEqual([]);
		const owner = bot.conversation({ userId: actor.user.id, channelId: channel.id });
		expect(owner.messages.filter(message => message.visibility === 'ephemeral')).toMatchObject([
			{ ownerId: actor.user.id, payload: { content: 'joined' } },
			{ ownerId: actor.user.id, payload: { content: 'welcome' } },
		]);
	} finally {
		await bot.close();
	}
});

test('a button modal remains available after its handler returns', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'button-modal-lifetime', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const actor = world.registerMember(guild.id, { user: apiUser({ id: 'button-modal-user' }) });
	@Declare({ name: 'button-modal-panel', description: 'Open a modal' })
	class Panel extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({
				content: 'panel',
				components: [
					new ActionRow<Button>().setComponents(
						new Button().setCustomId('open-details').setLabel('Open').setStyle(ButtonStyle.Primary),
						new Button().setCustomId('replace-details').setLabel('Replace').setStyle(ButtonStyle.Primary),
					),
				],
			});
		}
	}
	class Open extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'open-details';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.interaction.modal(
				new Modal()
					.setCustomId('button-details')
					.setTitle('Details')
					.setComponents([
						new Label()
							.setLabel('Name')
							.setComponent(new TextInput({ custom_id: 'name', style: TextInputStyle.Short })),
					])
					.run(async submit => {
						if (!submit) return;
						await submit.write({ content: 'submitted' });
					}),
			);
		}
	}
	class Replace extends ComponentCommand {
		componentType = 'Button' as const;
		customId = 'replace-details';
		async run(ctx: ComponentContext<'Button'>) {
			await ctx.interaction.modal(
				new Modal()
					.setCustomId('replacement-details')
					.setTitle('Replacement')
					.setComponents([
						new Label()
							.setLabel('Email')
							.setComponent(new TextInput({ custom_id: 'email', style: TextInputStyle.Short })),
					])
					.run(async submit => {
						if (!submit) return;
						await submit.write({ content: 'replacement submitted' });
					}),
			);
		}
	}
	const bot = await createMockBot({ commands: [Panel], components: [Open, Replace], world });
	const events: MockBotEvent[] = [];
	bot.observe(event => events.push(event));
	try {
		await bot.slash({ name: 'button-modal-panel', guildId: guild.id, channel, user: actor.user });
		const panel = bot.conversation({ userId: actor.user.id, channelId: channel.id }).messages.at(-1);
		expect(panel).toBeDefined();
		await bot.clickButton('open-details', { guildId: guild.id, channel, user: actor.user, source: panel?.id });
		await new Promise(resolve => setTimeout(resolve, 50));
		const modalCallback = bot.restCalls().findLast(action => action.body?.type === 9);
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'dispatch', phase: 'end', dispatchId: modalCallback?.dispatchId }),
		);
		expect(bot.pendingInteractions().modals).toMatchObject([{ userId: actor.user.id, customId: 'button-details' }]);
		await expect(
			bot.submitModal('button-details', { name: 'Bob' }, { user: apiUser({ id: 'other-modal-user' }) }),
		).rejects.toThrow(/is not available in the current state for user/);
		const first = await bot.submitModal('button-details', { name: 'Alice' }, { user: actor.user });
		expect(first.content).toBe('submitted');
		await bot.clickButton('open-details', { guildId: guild.id, channel, user: actor.user, source: panel?.id });
		await new Promise(resolve => setTimeout(resolve, 50));
		await bot.clickButton('replace-details', { guildId: guild.id, channel, user: actor.user, source: panel?.id });
		expect(bot.pendingInteractions().modals).toMatchObject([
			{ userId: actor.user.id, customId: 'replacement-details' },
		]);
		await expect(bot.submitModal('button-details', { name: 'Alice' }, { user: actor.user })).rejects.toThrow(
			/replacement-details/,
		);
		await expect(bot.submitModal('replacement-details', { name: 'Alice' }, { user: actor.user })).rejects.toThrow(
			/not inputs on the displayed modal/,
		);
		const result = await bot.submitModal('replacement-details', { email: 'alice@example.com' }, { user: actor.user });
		expect(result.content).toBe('replacement submitted');
		expect(bot.pendingInteractions().modals).toEqual([]);
		await bot.clickButton('open-details', { guildId: guild.id, channel, user: actor.user, source: panel?.id });
		expect(bot.pendingInteractions().modals).toHaveLength(1);
		await bot.reset();
		expect(bot.pendingInteractions().modals).toEqual([]);
	} finally {
		await bot.close();
	}
});

test('ephemeral collector continuation replies and followups retain the opening user', async () => {
	const world = mockWorld();
	const guild = world.registerGuild({ id: 'collector-ephemeral-guild', everyonePermissions: ['ViewChannel'] });
	const channel = world.registerChannel(guild.id);
	const owner = world.registerMember(guild.id, { user: apiUser({ id: 'collector-ephemeral-owner' }) });
	const other = world.registerMember(guild.id, { user: apiUser({ id: 'collector-ephemeral-other' }) });
	@Declare({ name: 'private-collect', description: 'Private collector' })
	class PrivateCollect extends Command {
		async run(ctx: CommandContext) {
			const message = await ctx.write(
				{
					content: 'Continue',
					components: [
						new ActionRow<Button>().setComponents(
							new Button().setCustomId('private-continue').setLabel('Continue').setStyle(ButtonStyle.Primary),
						),
					],
				},
				true,
			);
			const click = await message.createComponentCollector().waitFor('private-continue');
			if (!click) return;
			await click.write({ content: 'private reply', flags: MessageFlags.Ephemeral });
			await click.followup({ content: 'private followup', flags: MessageFlags.Ephemeral });
		}
	}
	const bot = await createMockBot({ commands: [PrivateCollect], world });
	try {
		await bot.slash({ name: 'private-collect', guildId: guild.id, channel, user: owner.user });
		const source = bot.conversation({ userId: owner.user.id, channelId: channel.id }).messages.at(-1);
		await bot.clickButton('private-continue', { guildId: guild.id, channel, user: owner.user, source: source?.id });
		const owned = bot.conversation({ userId: owner.user.id, channelId: channel.id });
		const privateMessages = owned.messages.filter(message => message.visibility === 'ephemeral');
		expect(privateMessages.map(message => message.payload.content)).toEqual(['private reply', 'private followup']);
		expect(privateMessages.every(message => message.ownerId === owner.user.id && message.interactionId)).toBe(true);
		expect(bot.conversation({ userId: other.user.id, channelId: channel.id }).messages).toHaveLength(1);
		expect(owned.diagnostics.some(diagnostic => diagnostic.startsWith('ephemeral-owner-unknown'))).toBe(false);
	} finally {
		await bot.close();
	}
});

test('commandSchemas returns full JSON after deferred directory loading and keeps nested choices', async () => {
	const choices = [
		{ name: 'Fast', value: 'fast' },
		{ name: 'Slow', value: 'slow' },
	] as const;
	const options = { speed: createStringOption({ description: 'Speed', required: true, choices }) };
	@Declare({ name: 'set', description: 'Set mode' })
	@Group('mode')
	@Options(options)
	class SetMode extends SubCommand {
		async run(ctx: CommandContext<typeof options>) {
			await ctx.write({ content: ctx.options.speed });
		}
	}
	@Declare({ name: 'lab-config', description: 'Configure lab' })
	@Groups({ mode: { defaultDescription: 'Mode' } })
	@Options([SetMode])
	class Config extends Command {}
	const bot = await createMockBot({ commands: [Config] });
	try {
		const schemas = await bot.commandSchemas();
		expect(schemas.find(schema => schema.name === 'lab-config')).toMatchObject({
			options: [{ name: 'mode', options: [{ name: 'set', options: [{ name: 'speed', choices }] }] }],
		});
	} finally {
		await bot.close();
	}
	const directoryBot = await createMockBot({
		commandsDir: join(process.cwd(), 'test/fixtures/e2e-commands'),
		loadModule: path => import(path),
	});
	try {
		expect(directoryBot.registeredCommands().some(entry => !entry.loaded)).toBe(true);
		const schemas = await directoryBot.commandSchemas();
		expect(schemas.some(schema => schema.name === 'catalog')).toBe(true);
		expect(schemas.some(schema => schema.name === 'ping')).toBe(true);
	} finally {
		await directoryBot.close();
	}
});
