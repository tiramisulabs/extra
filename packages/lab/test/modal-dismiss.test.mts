import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { MessageFlags } from 'seyfert';
import { expect, test } from 'vitest';
import { defineProject, defineScenario, type LabAction, type Project } from '../src';
import { validateLabAction } from '../src/protocol';
import { createCheckpoint, createSession, replay } from '../src/runtime';

const fixture = resolve(process.cwd(), 'test/fixtures/project.cjs');
const require = createRequire(fixture);
const { project } = require(fixture) as { project: Project };
const preset = { scenario: { id: 'flow', version: 1 } };
const slash = { kind: 'user', actor: 'alice', verb: 'slash', command: 'flow' } as const;
const click = {
	kind: 'user',
	actor: 'alice',
	verb: 'click',
	customId: 'open',
	source: { channel: 'channel', contains: 'Panel', customId: 'open' },
} as const;
const modal = async (session: ReturnType<typeof createSession>, actor = 'alice') => {
	const userId = (await session.describe()).refs[actor];
	return (
		(await session.inspect()).pending as {
			modals: {
				userId: string;
				interactionId: string;
				closed: boolean;
				customId: string;
				source?: {
					channelId?: string;
					messageId?: string;
					customId?: string;
					commandName?: string;
					group?: string;
					subcommand?: string;
					options?: unknown;
				};
			}[];
		}
	).modals.find(item => item.userId === userId);
};

test('closing and trigger reopening keep the pending modal and submit completes it', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		await session.act(slash);
		await session.act(click);
		const first = await modal(session);
		const description = await session.describe();
		const panel = (await session.view('alice', 'channel')).messages.find(item => item.payload.content === 'Panel');
		expect(first).toMatchObject({
			customId: 'answer',
			closed: false,
			source: { channelId: description.refs.channel, messageId: panel?.id, customId: 'open' },
		});
		for (let i = 0; i < 2; i++) {
			await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' });
			expect((await modal(session))?.closed).toBe(true);
			expect(await session.act(click)).toMatchObject({ dispatchIds: [], summary: 'modal reopened' });
			expect(await modal(session)).toMatchObject({ interactionId: first?.interactionId, closed: false });
		}
		await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' });
		await session.act({ kind: 'local', op: 'reopenModal', actor: 'alice', customId: 'answer' });
		expect((await modal(session))?.closed).toBe(false);
		await expect(session.act({ ...slash, command: 'private-panel' })).rejects.toThrow('unfinished form “Answer”');
		expect(await modal(session)).toMatchObject({ interactionId: first?.interactionId });
		await session.act({
			kind: 'user',
			actor: 'alice',
			verb: 'submitModal',
			customId: 'answer',
			fields: { value: 'yes' },
		});
		expect(await modal(session)).toBeUndefined();
		await session.act(click);
		expect((await modal(session))?.interactionId).not.toBe(first?.interactionId);
		await session.reset();
		expect((await session.inspect()).pending).toMatchObject({ modals: [] });
		expect((await session.inspect()).local).toEqual({ dismissed: {} });
	} finally {
		await session.dispose();
	}
});

test('a reused customId on another message cannot reopen the first modal', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		const description = await session.describe();
		expect(description.actors.find(actor => actor.key === 'alice')?.userId).toBe(description.refs.alice);
		await session.act(slash);
		await session.act(slash);
		const panels = (await session.view('alice', 'channel')).messages.filter(item => item.payload.content === 'Panel');
		expect(panels).toHaveLength(2);
		await session.act({ ...click, source: { channel: 'channel', messageRef: panels[0].id, customId: 'open' } });
		await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' });
		await expect(
			session.act({ ...click, source: { channel: 'channel', messageRef: panels[1].id, customId: 'open' } }),
		).rejects.toThrow('unfinished form “Answer”');
		expect((await modal(session))?.closed).toBe(true);
	} finally {
		await session.dispose();
	}
});

test('slash opener requires the same channel, subcommand and options', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		const command = {
			kind: 'user',
			actor: 'alice',
			verb: 'slash',
			command: 'support',
			subcommand: 'form',
			options: { topic: 'a' },
		} as const;
		await session.act(command);
		await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'support-form' });
		for (const different of [
			{ ...command, channel: 'other-channel' },
			{ ...command, subcommand: 'other', options: undefined },
			{ ...command, options: { topic: 'b' } },
		])
			await expect(session.act(different)).rejects.toThrow('unfinished form “Support form”');
		const first = await modal(session);
		expect(first?.source).toMatchObject({
			channelId: (await session.describe()).refs.channel,
			commandName: 'support',
			subcommand: 'form',
			options: { topic: 'a' },
		});
		expect(first?.source?.group).toBeUndefined();
		expect(await session.act(command)).toMatchObject({ dispatchIds: [], summary: 'modal reopened' });
		expect(await modal(session)).toMatchObject({ interactionId: first?.interactionId, closed: false });
	} finally {
		await session.dispose();
	}
});

test('slash trigger reopens its modal and timeout permits a new click dispatch', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		const command = { kind: 'user', actor: 'alice', verb: 'slash', command: 'pick-modal' } as const;
		await session.act(command);
		const first = await modal(session);
		expect(first?.source).toMatchObject({
			channelId: (await session.describe()).refs.channel,
			commandName: 'pick-modal',
			options: {},
		});
		await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'pick-modal' });
		expect(await session.act(command)).toMatchObject({ dispatchIds: [], summary: 'modal reopened' });
		expect((await modal(session))?.interactionId).toBe(first?.interactionId);
		await session.act({
			kind: 'user',
			actor: 'alice',
			verb: 'submitModal',
			customId: 'pick-modal',
			fields: { reasons: ['spam', 'abuse'] },
		});
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'short-flow' });
		const shortClick = {
			...click,
			customId: 'open-short',
			source: { channel: 'channel', contains: 'Short panel', customId: 'open-short' },
		} as const;
		await session.act(shortClick);
		const stale = await modal(session);
		await new Promise(done => setTimeout(done, 90));
		expect(await modal(session)).toBeUndefined();
		expect((await session.act(shortClick)).dispatchIds).toHaveLength(1);
		expect((await modal(session))?.interactionId).not.toBe(stale?.interactionId);
	} finally {
		await session.dispose();
	}
});

test('dismiss is local to the owner, excludes locate, and replays with modal actions', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		for (const actor of ['alice', 'bob'])
			await session.act({ kind: 'user', actor, verb: 'slash', command: 'private-panel' });
		const aliceMessage = (await session.view('alice', 'channel')).messages.find(
			item => item.payload.content === 'private panel',
		);
		const bobMessage = (await session.view('bob', 'channel')).messages.find(
			item => item.payload.content === 'private panel',
		);
		expect(aliceMessage?.id).toBeTruthy();
		await expect(
			session.act({
				kind: 'local',
				op: 'dismissMessage',
				actor: 'alice',
				source: { channel: 'channel', messageRef: 'guild' },
			}),
		).rejects.toThrow('Message is no longer visible');
		await session.act({
			kind: 'local',
			op: 'dismissMessage',
			actor: 'alice',
			source: { channel: 'channel', contains: 'private panel' },
		});
		expect((await session.view('alice', 'channel')).messages.some(item => item.id === aliceMessage?.id)).toBe(false);
		expect((await session.view('bob', 'channel')).messages.some(item => item.id === bobMessage?.id)).toBe(true);
		await expect(
			session.act({
				kind: 'user',
				actor: 'alice',
				verb: 'click',
				customId: 'private',
				source: { channel: 'channel', contains: 'private panel' },
			}),
		).rejects.toThrow('Locator matched 0');
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'private-panel' });
		expect(
			(await session.view('alice', 'channel')).messages.filter(item => item.payload.content === 'private panel'),
		).toHaveLength(1);
		await session.act(slash);
		await session.act(click);
		const opened = await modal(session);
		expect(opened?.source).toMatchObject({ channelId: (await session.describe()).refs.channel, customId: 'open' });
		await session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' });
		expect(await session.act(click)).toMatchObject({ dispatchIds: [], summary: 'modal reopened' });
		expect((await modal(session))?.interactionId).toBe(opened?.interactionId);
		await session.act({
			kind: 'user',
			actor: 'alice',
			verb: 'submitModal',
			customId: 'answer',
			fields: { value: 'done' },
		});
		const checkpoint = createCheckpoint(await session.log(), 'dismiss_and_reopen', [
			{ view: { actor: 'alice', channel: 'channel' }, contains: 'saved:done' },
			{ view: { actor: 'bob', channel: 'channel' }, contains: 'private panel' },
		]);
		expect((await replay(project, checkpoint)).log.entries).toHaveLength(checkpoint.actions.length);
		await session.reset();
		expect((await session.inspect()).local).toEqual({ dismissed: {} });
	} finally {
		await session.dispose();
	}
});

test('a second dismiss of the same message cannot consume an identical newer ephemeral', async () => {
	const session = createSession(project, preset);
	await session.start();
	try {
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'private-panel' });
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'private-panel' });
		const messages = (await session.view('alice', 'channel')).messages.filter(
			item => item.payload.content === 'private panel',
		);
		expect(messages).toHaveLength(2);
		const dismiss = {
			kind: 'local',
			op: 'dismissMessage',
			actor: 'alice',
			source: {
				channel: 'channel',
				messageRef: messages[0].id,
				contains: 'private panel',
			},
		} as const;
		await session.act(dismiss);
		await expect(session.act(dismiss)).rejects.toThrow('Message is no longer visible');
		expect(
			(await session.view('alice', 'channel')).messages
				.filter(item => item.payload.content === 'private panel')
				.map(item => item.id),
		).toEqual([messages[1].id]);
	} finally {
		await session.dispose();
	}
});

test('replay maps an embed-only ephemeral dismiss to visible text', async () => {
	const embedded = defineProject({
		name: 'embed-dismiss',
		scenarios: [
			defineScenario({
				id: 'embed',
				version: 1,
				title: 'Embed',
				world(world) {
					const guild = world.guild('guild', { everyonePermissions: ['ViewChannel'] });
					const channel = world.channel('channel', guild);
					const alice = world.member('alice', guild);
					world.message('embed', channel, {
						flags: MessageFlags.Ephemeral,
						ownerId: alice,
						embeds: [{ title: 'Private title' }],
					});
				},
				actors: () => ({ alice: { userId: 'alice', guildId: 'guild', channelId: 'channel' } }),
			}),
		],
		bot: () => ({}),
	});
	const embedPreset = { scenario: { id: 'embed', version: 1 } };
	const session = createSession(embedded, embedPreset);
	await session.start();
	let checkpoint;
	try {
		await session.act({
			kind: 'local',
			op: 'dismissMessage',
			actor: 'alice',
			source: { channel: 'channel', messageRef: 'embed' },
		});
		checkpoint = createCheckpoint(await session.log(), 'embed_dismiss', [
			{ view: { actor: 'alice', channel: 'channel' }, contains: 'Private title', absent: true },
		]);
		expect(checkpoint.actions[0]).toMatchObject({ source: { messageRef: 'embed', contains: 'Private title' } });
	} finally {
		await session.dispose();
	}
	expect((await replay(embedded, checkpoint)).log.entries[0].outcome.ok).toBe(true);
});

test('validates all local operations', () => {
	for (const action of [
		{ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' },
		{ kind: 'local', op: 'reopenModal', actor: 'alice', customId: 'answer' },
		{ kind: 'local', op: 'dismissMessage', actor: 'alice', source: { channel: 'channel', contains: 'private' } },
	] satisfies LabAction[])
		expect(() => validateLabAction(action)).not.toThrow();
	for (const action of [
		{ kind: 'local', op: 'dismissMessage', actor: 'alice', source: { channel: 'channel' } },
		{ kind: 'local', op: 'reopenModal', actor: 'alice' },
	])
		expect(() => validateLabAction(action)).toThrow('Invalid protocol');
});
