import { execFileSync } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { apiUser } from '@slipher/testing';
import { Command, type CommandContext, Declare } from 'seyfert';
import { expect, test } from 'vitest';
import { type Checkpoint, defineProject, defineScenario, type Project } from '../src';
import { PROTOCOL_VERSION, validateCheckpoint } from '../src/protocol';
import { createCheckpoint, createSession, exportTest, replay } from '../src/runtime';

const projectModule = resolve(process.cwd(), 'test/fixtures/project.cjs');
const require = createRequire(projectModule);
const { project } = require(projectModule) as { project: Project };
const preset = { scenario: { id: 'flow', version: 1 } };

test('checkpoint replay preserves permission-at-delivery visibility for each actor', async () => {
	@Declare({ name: 'before-view', description: 'Send before view' })
	class BeforeView extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'before view' });
		}
	}
	@Declare({ name: 'after-view', description: 'Send after view' })
	class AfterView extends Command {
		async run(ctx: CommandContext) {
			await ctx.write({ content: 'after view' });
		}
	}
	const receiptProject = defineProject({
		name: 'live-receipt',
		scenarios: [
			defineScenario({
				id: 'receipt',
				version: 1,
				title: 'Live receipt',
				world(w) {
					const guild = w.guild('guild', { everyonePermissions: [] });
					const view = w.role('view', guild, { permissions: ['ViewChannel'] });
					w.channel('channel', guild);
					w.member('alice', guild);
					w.member('bob', guild, { roles: [view] });
				},
				actors: refs => ({
					alice: { userId: refs.alice, guildId: refs.guild, channelId: refs.channel },
					bob: { userId: refs.bob, guildId: refs.guild, channelId: refs.channel },
				}),
			}),
		],
		bot: () => ({ commands: [BeforeView, AfterView] }),
	});
	const session = createSession(receiptProject, { scenario: { id: 'receipt', version: 1 } });
	await session.start();
	let checkpoint: Checkpoint;
	try {
		await session.act({ kind: 'user', actor: 'bob', verb: 'slash', command: 'before-view' });
		await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'view' });
		expect((await session.view('alice', 'channel')).messages).toEqual([]);
		await session.act({ kind: 'user', actor: 'bob', verb: 'slash', command: 'after-view' });
		expect((await session.view('alice', 'channel')).messages.map(message => message.payload.content)).toEqual([
			'after view',
		]);
		expect((await session.view('bob', 'channel')).messages.map(message => message.payload.content)).toEqual([
			'before view',
			'after view',
		]);
		checkpoint = createCheckpoint(await session.log(), 'live_receipt', [
			{ view: { actor: 'alice', channel: 'channel' }, contains: 'before view', absent: true },
			{ view: { actor: 'alice', channel: 'channel' }, contains: 'after view' },
			{ view: { actor: 'bob', channel: 'channel' }, contains: 'before view' },
		]);
	} finally {
		await session.dispose();
	}
	const replayed = await replay(receiptProject, checkpoint);
	expect(replayed.log.entries).toHaveLength(3);
});

test('replay checks outcomes, roles and visible arrival with a fresh collector', async () => {
	const session = createSession(project, preset);
	await session.start();
	let checkpoint: Checkpoint;
	try {
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'flow' });
		await session.act({
			kind: 'user',
			actor: 'alice',
			verb: 'click',
			customId: 'open',
			source: { channel: 'channel', customId: 'open', contains: 'Panel' },
		});
		await session.act({
			kind: 'user',
			actor: 'alice',
			verb: 'submitModal',
			customId: 'answer',
			fields: { value: 'yes' },
		});
		await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'ban' });
		checkpoint = createCheckpoint(await session.log(), 'flow_saved', [
			{ view: { actor: 'alice', channel: 'channel' }, contains: 'saved:yes' },
			{ role: { guild: 'guild', member: 'alice', role: 'ban' }, present: true },
			{ project: { name: 'fixture', path: 'label' }, equals: 'Panel' },
			{ action: 2, ok: true },
		]);
	} finally {
		await session.dispose();
	}
	const result = await replay(project, checkpoint);
	expect(result.log.entries).toHaveLength(4);
	await expect(
		replay(project, { ...checkpoint, arrival: [{ path: 'world.messages.1.content', equals: 'wrong' }] }),
	).rejects.toThrow('expected "wrong", got "saved:yes"');
	expect(() => validateCheckpoint({ ...checkpoint, version: 99 })).toThrow('checkpoint version: 99');
	expect(() => validateCheckpoint({ ...checkpoint, callback: () => undefined })).toThrow('checkpoint JSON data');
	await expect(replay(project, { ...checkpoint, preset: { scenario: { id: 'unknown', version: 1 } } })).rejects.toThrow(
		'scenario unknown@1',
	);
});

test('recorded action errors replay with a pattern and show a mismatch', async () => {
	const session = createSession(project, preset);
	await session.start();
	let checkpoint: Checkpoint;
	try {
		await expect(
			session.act({
				kind: 'user',
				actor: 'alice',
				verb: 'click',
				customId: 'missing',
				source: { channel: 'channel', customId: 'missing' },
			}),
		).rejects.toThrow('Locator matched 0');
		await expect(session.act({ kind: 'local', op: 'closeModal', actor: 'alice', customId: 'answer' })).rejects.toThrow(
			'No pending modal',
		);
		checkpoint = createCheckpoint(await session.log(), 'expected_error', [
			{ action: 0, ok: false, error: 'Locator matched 0' },
		]);
	} finally {
		await session.dispose();
	}
	expect((await replay(project, checkpoint)).log.entries).toHaveLength(2);
	await expect(
		replay(project, { ...checkpoint, arrival: [{ action: 0, ok: false, error: 'other error' }] }),
	).rejects.toThrow('failed action 1');
});

test('visible arrival reads rendered text without JSON escaping or metadata matches', async () => {
	const visibleProject = defineProject({
		name: 'visible-text',
		scenarios: [
			defineScenario({
				id: 'text',
				version: 1,
				title: 'Text',
				world(world) {
					const guild = world.guild('guild', { everyonePermissions: ['ViewChannel', 'ReadMessageHistory'] });
					const channel = world.channel('channel', guild);
					world.member('member', guild);
					world.message('message', channel, {
						content: 'Line one\nLine "two" \\ path',
						embeds: [
							{
								title: 'Embed title',
								description: 'Embed\nonly',
								fields: [{ name: 'Field name', value: 'Field value' }],
								footer: { text: 'Footer only' },
								author: { name: 'Author only' },
							},
						],
						components: [
							{ type: 17, components: [{ type: 10, content: 'Display\nonly' }] },
							{ type: 1, components: [{ type: 2, custom_id: 'hidden-id', label: 'Button label' }] },
							{
								type: 1,
								components: [
									{ type: 3, custom_id: 'select-id', placeholder: 'Pick one', options: [{ label: 'Choice' }] },
								],
							},
						],
					});
				},
				actors: refs => ({
					member: { userId: refs.member, guildId: refs.guild, channelId: refs.channel },
				}),
			}),
		],
		bot: () => ({}),
	});
	const preset = { scenario: { id: 'text', version: 1 } };
	const view = { actor: 'member', channel: 'channel' };
	const checkpoint = {
		version: 1 as const,
		labVersion: '0.0.0',
		protocolVersion: PROTOCOL_VERSION,
		name: 'visible_text',
		preset,
		actions: [],
		arrival: [
			{ view, contains: 'Line one\nLine "two" \\ path' },
			{ view, contains: 'Embed title' },
			{ view, contains: 'Embed\nonly' },
			{ view, contains: 'Field name' },
			{ view, contains: 'Field value' },
			{ view, contains: 'Footer only' },
			{ view, contains: 'Author only' },
			{ view, contains: 'Display\nonly' },
			{ view, contains: 'Button label' },
			{ view, contains: 'Pick one' },
			{ view, contains: 'Choice' },
			{ view, contains: 'not rendered', absent: true as const },
			{ view, contains: 'hidden-id', absent: true as const },
			{ view, contains: 'Line one\\nLine', absent: true as const },
		],
	} satisfies Checkpoint;
	await replay(visibleProject, checkpoint);
	await expect(
		replay(visibleProject, {
			...checkpoint,
			arrival: [{ view, contains: 'Display\nonly', absent: true }],
		}),
	).rejects.toThrow('Display\nonly is present');
});

test('member refs survive generated apiUser ids and reject explicit ref conflicts', async () => {
	const memberProject = defineProject({
		name: 'member-refs',
		scenarios: [
			defineScenario({
				id: 'members',
				version: 1,
				title: 'Members',
				world(world) {
					const guild = world.guild('guild', { everyonePermissions: ['ViewChannel'] });
					world.channel('channel', guild);
					world.member('member', guild, { user: apiUser({ username: 'Member' }) });
				},
				actors: refs => ({
					member: { userId: refs.member, guildId: refs.guild, channelId: refs.channel },
				}),
			}),
		],
		bot: () => ({}),
	});
	const session = createSession(memberProject, { scenario: { id: 'members', version: 1 } });
	await session.start();
	let checkpoint: Checkpoint;
	let memberId: string;
	try {
		const description = await session.describe();
		memberId = description.refs.member;
		const inspect = await session.inspect();
		expect((inspect.world as { members: { userId: string }[] }).members[0].userId).toBe(memberId);
		checkpoint = createCheckpoint(await session.log(), 'member_ids', [
			{ path: 'world.members.0.userId', equals: memberId },
		]);
	} finally {
		await session.dispose();
	}
	const replayed = await replay(memberProject, checkpoint);
	expect(replayed.log.preset.refs?.member).toBe(memberId);
	expect((replayed.inspect.world as { members: { userId: string }[] }).members[0].userId).toBe(memberId);

	const conflicting = defineProject({
		...memberProject,
		scenarios: [
			defineScenario({
				...memberProject.scenarios[0],
				world(world, { ref }) {
					const guild = world.guild('guild');
					ref('member', '111111111111111111');
					world.member('member', guild, { user: apiUser({ id: '111111111111111111' }) });
				},
			}),
		],
	});
	await expect(
		createSession(conflicting, {
			scenario: { id: 'members', version: 1 },
			refs: { member: '222222222222222222' },
		}).start(),
	).rejects.toThrow('Ref "member" override conflicts with preset');
});

test('exported Node test typechecks and executes with CJS and ESM projects', async () => {
	const session = createSession(project, preset);
	await session.start();
	let checkpoint: Checkpoint;
	try {
		await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'support', subcommand: 'open' });
		checkpoint = createCheckpoint(
			await session.log(),
			'exported_flow',
			[{ view: { actor: 'alice', channel: 'channel' }, contains: 'support opened' }],
			projectModule,
		);
	} finally {
		await session.dispose();
	}
	const file = resolve(process.cwd(), 'test/fixtures/generated-checkpoint.test.mts');
	try {
		for (const modulePath of [projectModule, resolve(process.cwd(), 'test/fixtures/project.mjs')]) {
			await writeFile(file, exportTest(checkpoint, { format: 'node', projectModule: modulePath }));
			try {
				execFileSync(
					'./node_modules/.bin/tsc',
					[
						'--ignoreConfig',
						'--noEmit',
						'--module',
						'NodeNext',
						'--moduleResolution',
						'NodeNext',
						'--target',
						'ESNext',
						'--types',
						'node',
						'--skipLibCheck',
						file,
					],
					{
						cwd: process.cwd(),
						timeout: 30000,
					},
				);
			} catch (error) {
				throw new Error(error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : String(error));
			}
			const output = execFileSync(process.execPath, ['--test', file], {
				cwd: process.cwd(),
				encoding: 'utf8',
				timeout: 30000,
			});
			expect(output).toContain('pass 1');
		}
	} finally {
		await unlink(file);
	}
	const empty = { ...checkpoint, actions: [], outcomes: [], arrival: [] };
	expect(exportTest(empty, { format: 'node' })).toContain('Checkpoint has no explicit expectations');
	expect(() => validateCheckpoint({ ...checkpoint, protocolVersion: PROTOCOL_VERSION + 1 })).toThrow('protocolVersion');
});
