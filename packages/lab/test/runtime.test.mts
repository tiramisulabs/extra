import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MessageFlags } from 'seyfert';
import { describe, expect, test, vi } from 'vitest';
import { type Checkpoint, defineProject, defineScenario, type Preset, type SessionEvent } from '../src';
import { createChildSession } from '../src/child';
import { isBridgeMessage, PROTOCOL_VERSION, validateBridgeRequest, validateLabAction } from '../src/protocol';
import { createSession, deterministicId, replay } from '../src/runtime';

const fixturePath = resolve(process.cwd(), 'test/fixtures/project.cjs');
const require = createRequire(fixturePath);
const { project } = require(fixturePath) as { project: ReturnType<typeof defineProject> };
const preset: Preset = { scenario: { id: 'flow', version: 1 }, params: { label: 'Panel' } };
const slash = { kind: 'user', actor: 'alice', verb: 'slash', command: 'flow' } as const;
const click = {
	kind: 'user',
	actor: 'alice',
	verb: 'click',
	customId: 'open',
	source: { channel: 'channel', contains: 'Panel', customId: 'open' },
} as const;
const submit = {
	kind: 'user',
	actor: 'alice',
	verb: 'submitModal',
	customId: 'answer',
	fields: { value: 'yes' },
} as const;

async function readWhenPresent(path: string, timeoutMs = 5000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await new Promise<void>(done => setImmediate(done));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

describe('lab runtime', () => {
	test('views keep history and ephemeral visibility scoped to each actor', async () => {
		const isolated = defineProject({
			name: 'visibility',
			scenarios: [
				defineScenario({
					id: 'history',
					version: 1,
					title: 'History',
					world(w) {
						const guild = w.guild('guild', { everyonePermissions: ['ViewChannel'] });
						const read = w.role('read', guild, { permissions: ['ReadMessageHistory'] });
						const channel = w.channel('channel', guild);
						const alice = w.member('alice', guild);
						w.member('bob', guild, { roles: [read] });
						w.message('public', channel, { content: 'seeded public' });
						w.message('private', channel, { content: 'seeded private', flags: MessageFlags.Ephemeral, ownerId: alice });
					},
					actors: refs => ({
						alice: { userId: refs.alice, guildId: refs.guild, channelId: refs.channel },
						bob: { userId: refs.bob, guildId: refs.guild, channelId: refs.channel },
					}),
				}),
			],
			bot: () => ({}),
		});
		const session = createSession(isolated, { scenario: { id: 'history', version: 1 } });
		await session.start();
		try {
			expect((await session.view('alice', 'channel')).messages.map(message => message.payload.content)).toEqual([
				'seeded private',
			]);
			expect((await session.view('alice', 'channel')).diagnostics).toContain('history-hidden:1');
			expect((await session.view('bob', 'channel')).messages.map(message => message.payload.content)).toEqual([
				'seeded public',
			]);
			expect((await session.view('alice', 'channel')).messages.map(message => message.payload.content)).toEqual([
				'seeded private',
			]);
			expect((await session.describe()).guilds[0].channels[0].visibleTo).toEqual(['alice', 'bob']);
			await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'read' });
			expect((await session.view('alice', 'channel')).messages.map(message => message.payload.content)).toEqual([
				'seeded public',
				'seeded private',
			]);
			await session.reset();
			expect((await session.view('alice', 'channel')).messages.map(message => message.payload.content)).toEqual([
				'seeded private',
			]);
		} finally {
			await session.dispose();
		}
	});
	test('concurrent start rejects and dispose during start waits for cleanup', async () => {
		let releaseSetup: (() => void) | undefined;
		let disposals = 0;
		const slow = defineProject({
			name: 'slow',
			scenarios: [defineScenario({ id: 'life', version: 1, title: 'Life' })],
			resources: {
				setup: () =>
					new Promise<object>(done => {
						releaseSetup = () => done({});
					}),
				dispose: () => {
					disposals++;
				},
			},
			bot: () => ({}),
		});
		const session = createSession(slow, { scenario: { id: 'life', version: 1 } });
		const starting = session.start();
		await expect(session.start()).rejects.toThrow('Session is starting');
		const disposing = session.dispose();
		await Promise.resolve();
		releaseSetup?.();
		await starting;
		await disposing;
		expect(disposals).toBe(1);
		await expect(session.inspect()).rejects.toThrow('not started');
	});

	test('channel created by an action can receive the next action', async () => {
		const session = createSession(project, preset);
		await session.start();
		try {
			await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'create-channel' });
			expect(
				(
					await session.act({
						kind: 'user',
						actor: 'alice',
						verb: 'slash',
						command: 'support',
						subcommand: 'open',
						channel: '888888888888888888',
					})
				).summary,
			).toBe('support opened');
		} finally {
			await session.dispose();
		}
	});

	test('RPC timeout rejects all pending calls and stops the child', async () => {
		const child = createChildSession({
			projectModule: resolve(process.cwd(), 'test/fixtures/lifecycle.cjs'),
			preset: { scenario: { id: 'life', version: 1 } },
			rpcTimeoutMs: 80,
			disposeTimeoutMs: 100,
		});
		await child.start();
		const { pid } = (await child.inspectProject('identity')) as { pid: number };
		const hung = child.inspectProject('hang');
		const waiting = child.inspect();
		await expect(hung).rejects.toThrow('session.inspectProject timed out after 80ms; external cleanup may be pending');
		await expect(waiting).rejects.toThrow('session.inspectProject timed out after 80ms');
		await new Promise(done => setTimeout(done, 800));
		await expect(child.inspect()).rejects.toThrow('not running');
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test('start timeout lets a slow setup finish and runs dispose', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'slipher-lab-start-'));
		const started = resolve(dir, 'started');
		const gate = resolve(dir, 'gate');
		const finished = resolve(dir, 'finished');
		const marker = resolve(dir, 'disposed');
		const child = createChildSession({
			projectModule: resolve(process.cwd(), 'test/fixtures/lifecycle.cjs'),
			preset: { scenario: { id: 'life', version: 1 } },
			env: {
				LAB_SETUP_STARTED_MARKER: started,
				LAB_SETUP_GATE: gate,
				LAB_SETUP_FINISHED_MARKER: finished,
				LAB_DISPOSE_MARKER: marker,
			},
			startTimeoutMs: 80,
			disposeTimeoutMs: 500,
		});
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const starting = child.start();
		const rejection = starting.catch(error => error);
		try {
			await readWhenPresent(started);
			vi.advanceTimersByTime(80);
			await writeFile(gate, 'open');
			const error: unknown = await rejection;
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(AggregateError);
			expect((error as Error).message).toBe('session.start timed out after 80ms; external cleanup may be pending');
			expect(await readWhenPresent(finished)).toBe('finished');
			expect(await readWhenPresent(marker, 2000)).toBe('disposed after setup');
		} finally {
			vi.useRealTimers();
			await writeFile(gate, 'open');
			await child.dispose().catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});
	test('start timeout forces exit when setup never completes', async () => {
		const dir = await mkdtemp(resolve(tmpdir(), 'slipher-lab-start-stuck-'));
		const started = resolve(dir, 'started');
		const gate = resolve(dir, 'gate');
		const child = createChildSession({
			projectModule: resolve(process.cwd(), 'test/fixtures/lifecycle.cjs'),
			preset: { scenario: { id: 'life', version: 1 } },
			env: { LAB_SETUP_STARTED_MARKER: started, LAB_SETUP_GATE: gate },
			startTimeoutMs: 80,
			disposeTimeoutMs: 100,
		});
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const starting = child.start();
		const rejection = starting.catch(error => error);
		try {
			const pid = Number(await readWhenPresent(started));
			vi.advanceTimersByTime(80);
			await new Promise<void>(done => setImmediate(done));
			// The dispose RPC covers bot close plus resource dispose: 2 * disposeTimeoutMs + 250.
			vi.advanceTimersByTime(2 * 100 + 250);
			const error: unknown = await rejection;
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as Error).message).toContain('session.start timed out after 80ms');
			expect((error as Error).message).toContain('forced shutdown or cleanup failed; external cleanup may be pending');
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			vi.useRealTimers();
			await writeFile(gate, 'open');
			await child.dispose().catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});
	test('stable refs and validated params', async () => {
		expect(deterministicId('fixture:flow:guild')).toBe(deterministicId('fixture:flow:guild'));
		expect(deterministicId('fixture:flow:guild')).not.toBe(deterministicId('fixture:flow:channel'));
		await expect(createSession(project, { ...preset, params: { label: 4 } }).start()).rejects.toThrow(
			'Invalid parameter',
		);
		await expect(createSession(project, { ...preset, params: { label: null } as never }).start()).rejects.toThrow(
			'Invalid parameter',
		);
	});

	test('no optional hooks needed; actor steps, locator, and replay', async () => {
		const session = createSession(project, preset);
		const events: SessionEvent[] = [];
		session.observe(event => {
			events.push(event);
		});
		await session.start();
		try {
			await expect(session.act(click)).rejects.toThrow('Locator matched 0');
			await session.act(slash);
			await expect(session.act({ ...click, source: { channel: 'channel', contains: 'absent' } })).rejects.toThrow(
				'Locator matched 0',
			);
			await session.act(click);
			expect((await session.act(submit)).summary).toBe('saved:yes');
			expect(events.map(event => event.type)).toContain('interaction');
			expect(events).toContainEqual(
				expect.objectContaining({
					type: 'rest',
					phase: 'settled',
					detail: expect.objectContaining({ method: expect.any(String), route: expect.any(String), status: null }),
				}),
			);
			const checkpoint: Checkpoint = {
				version: 1,
				labVersion: (await session.log()).labVersion,
				protocolVersion: PROTOCOL_VERSION,
				name: 'saved',
				preset,
				actions: [slash, click, submit],
				arrival: [{ path: 'world.messages.1.content', equals: 'saved:yes' }],
			};
			const firstReplay = await replay(project, checkpoint);
			expect(firstReplay.inspect.world).toMatchObject({
				messages: expect.arrayContaining([expect.objectContaining({ content: 'saved:yes' })]),
			});
			expect((await replay(project, firstReplay.log, checkpoint.arrival)).log.entries).toHaveLength(3);
		} finally {
			await session.dispose();
		}
	});
	test('slash subcommand and live description follow the protocol', async () => {
		const session = createSession(project, preset);
		await session.start();
		try {
			expect(() =>
				validateLabAction({ kind: 'user', actor: 'alice', verb: 'slash', command: 'support', group: 'staff' }),
			).toThrow('action.subcommand');
			expect(
				(await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'support', subcommand: 'open' }))
					.summary,
			).toBe('support opened');
			const before = await session.describe();
			expect(before).toMatchObject({
				preset: { scenario: { id: 'flow', version: 1 } },
				refs: { guild: expect.any(String) },
				actors: expect.arrayContaining([expect.objectContaining({ key: 'alice', userId: before.refs.alice })]),
			});
			expect(before.guilds[0].channels[0].visibleTo).toContain('alice');
			expect(before.guilds[0].channels[0].visibleTo).not.toContain('carol');
			await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'ban' });
			expect(
				(await session.describe()).actors.find(actor => actor.key === 'alice')?.roles[before.refs.guild],
			).toContain(before.refs.ban);
		} finally {
			await session.dispose();
		}
	});
	test('user actions reject channels without ViewChannel and slash uses the selected channel', async () => {
		const session = createSession(project, preset);
		await session.start();
		try {
			await expect(session.act({ ...slash, actor: 'carol', channel: 'channel' })).rejects.toThrow(
				'cannot view channel "channel" (ViewChannel)',
			);
			await expect(session.act({ ...click, actor: 'carol' })).rejects.toThrow('cannot view channel');
			await expect(session.act({ ...submit, actor: 'carol', channel: 'channel' })).rejects.toThrow(
				'cannot view channel',
			);
			expect((await session.act({ ...slash, channel: 'channel' })).summary).toBe('Panel');
			await session.act({ ...slash, channel: 'other-channel' });
			expect(
				(await session.view('alice', 'other-channel')).messages.some(message => message.payload.content === 'Panel'),
			).toBe(true);
			const description = await session.describe();
			expect(description.guilds[0].members.map(member => member.id)).toContain(description.refs.alice);
			expect(description.guilds[0].roles.map(role => role.id)).toContain(description.refs.ban);
		} finally {
			await session.dispose();
		}
	});
	test('Seyfert modal StringSelect submits multiple values from a Label', async () => {
		const session = createSession(project, preset);
		await session.start();
		try {
			await session.act({ ...slash, command: 'pick-modal', channel: 'channel' });
			const modal = (await session.inspect()).pending as { modals: { payload: { components: unknown[] } }[] };
			expect(modal.modals[0].payload.components).toMatchObject([
				{
					type: 18,
					component: {
						type: 3,
						min_values: 2,
						max_values: 2,
						options: expect.arrayContaining([expect.objectContaining({ default: true, value: 'spam' })]),
					},
				},
			]);
			expect(
				(
					await session.act({
						kind: 'user',
						actor: 'alice',
						verb: 'submitModal',
						channel: 'channel',
						customId: 'pick-modal',
						fields: { reasons: ['spam', 'abuse'] },
					})
				).summary,
			).toBe('reasons:spam,abuse');
		} finally {
			await session.dispose();
		}
	});

	test('partial setup cleans resources on bot failure', async () => {
		const order: string[] = [];
		const broken = defineProject({
			name: 'broken',
			scenarios: [
				defineScenario({
					id: 'one',
					version: 1,
					title: 'One',
					world: () => {
						order.push('world');
					},
				}),
			],
			configure: () => {
				order.push('configure');
			},
			resources: {
				setup: () => {
					order.push('setup');
					return 1;
				},
				dispose: () => {
					order.push('dispose');
				},
			},
			bot: () => {
				order.push('bot');
				throw new Error('boot failed');
			},
		});
		await expect(createSession(broken, { scenario: { id: 'one', version: 1 } }).start()).rejects.toThrow('boot failed');
		expect(order).toEqual(['configure', 'setup', 'world', 'bot', 'dispose']);
	});

	test('services and seed follow bot startup', async () => {
		const order: string[] = [];
		const projectWithHooks = defineProject({
			name: 'ordered',
			scenarios: [
				defineScenario({
					id: 'one',
					version: 1,
					title: 'One',
					world: () => {
						order.push('world');
					},
					seed: () => {
						order.push('seed');
					},
				}),
			],
			configure: () => {
				order.push('configure');
			},
			resources: {
				setup: () => {
					order.push('setup');
					return 1;
				},
				dispose: () => {
					order.push('dispose');
				},
			},
			bot: () => {
				order.push('bot');
				return {};
			},
			services: {
				api: {
					default: 'ok',
					variants: {
						ok: () => {
							order.push('service');
						},
					},
				},
			},
		});
		const session = createSession(projectWithHooks, { scenario: { id: 'one', version: 1 } });
		await session.start();
		await session.reset();
		await session.dispose();
		expect(order).toEqual([
			'configure',
			'setup',
			'world',
			'bot',
			'service',
			'seed',
			'dispose',
			'configure',
			'setup',
			'world',
			'bot',
			'service',
			'seed',
			'dispose',
		]);
	});

	test('missing requirements are explicit', async () => {
		const missing = defineProject({
			name: 'missing',
			scenarios: [
				defineScenario({
					id: 'one',
					version: 1,
					title: 'One',
					requires: () => ['DATABASE_URL', 'queue'],
				}),
			],
			bot: () => ({}),
		});
		await expect(createSession(missing, { scenario: { id: 'one', version: 1 } }).start()).rejects.toThrow(
			'Missing requirements: DATABASE_URL, queue',
		);
	});

	test('ambiguous locator lists candidates', async () => {
		const duplicate = defineProject({
			...project,
			scenarios: [
				defineScenario({
					...project.scenarios[0],
					world(w, ctx) {
						project.scenarios[0].world?.(w, ctx);
						w.message('one', 'channel', { content: 'Panel' });
						w.message('two', 'channel', { content: 'Panel' });
					},
				}),
			],
		});
		const session = createSession(duplicate, preset);
		await session.start();
		try {
			await expect(session.act({ ...click, source: { channel: 'channel', contains: 'Panel' } })).rejects.toThrow(
				'Locator matched 2',
			);
		} finally {
			await session.dispose();
		}
	});

	test('child and in-process produce the same observable result', async () => {
		const inProcess = createSession(project, preset);
		const child = createChildSession({ projectModule: fixturePath, preset });
		await inProcess.start();
		await child.start();
		try {
			expect((await child.commandSchemas()).map(item => item.name)).toEqual(
				(await inProcess.commandSchemas()).map(item => item.name),
			);
			const outcomes = [];
			for (const session of [inProcess, child]) {
				await session.act(slash);
				await session.act(click);
				outcomes.push(await session.act(submit));
			}
			expect(outcomes[1].summary).toBe(outcomes[0].summary);
			const messages = async (session: typeof child) =>
				((await session.inspect()).world as { messages: { content: string }[] }).messages.map(item => item.content);
			expect(await messages(child)).toEqual(await messages(inProcess));
			expect((await child.view('alice', 'channel')).messages.map(item => item.payload.content)).toEqual(
				(await inProcess.view('alice', 'channel')).messages.map(item => item.payload.content),
			);
			const pending = async (session: typeof child) =>
				((await session.inspect()).pending as { collectors: { customIds?: string[] }[] }).collectors.map(
					item => item.customIds,
				);
			expect(await pending(child)).toEqual(await pending(inProcess));
		} finally {
			await child.dispose();
			await inProcess.dispose();
		}
	});

	test('member permissions, strict refs, admin roles, schemas and replay visibility', async () => {
		const session = createSession(project, { ...preset, refs: { alice: '123456789012345678' } });
		const events: string[] = [];
		session.observe(event => {
			events.push(event.type);
		});
		await session.start();
		try {
			expect((await session.commandSchemas()).map(item => item.name)).toContain('needs-role');
			expect((await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'needs-role' })).summary).toBe(
				'missing member perms',
			);
			await expect(
				session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'nobody', role: 'ban' }),
			).rejects.toThrow('available refs');
			await expect(
				session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: '999999999999999999', role: 'ban' }),
			).rejects.toThrow('available refs');
			await session.act({ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'ban' });
			expect((await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'needs-role' })).summary).toBe(
				'member ok',
			);
			await session.act({ kind: 'admin', op: 'removeRole', guild: 'guild', member: 'alice', role: 'ban' });
			expect((await session.act({ kind: 'user', actor: 'alice', verb: 'slash', command: 'needs-role' })).summary).toBe(
				'missing member perms',
			);
			const log = await session.log();
			expect(log).toMatchObject({
				labVersion: '0.0.0',
				protocolVersion: PROTOCOL_VERSION,
				preset: { refs: { alice: '123456789012345678' } },
			});
			expect(log.entries[3].action.kind).toBe('admin');
			expect(events).toEqual(expect.arrayContaining(['rest', 'dispatch', 'world', 'action']));
			const replayed = await replay(project, {
				version: 1,
				labVersion: log.labVersion,
				protocolVersion: PROTOCOL_VERSION,
				name: 'member_role',
				preset: log.preset,
				actions: [
					{ kind: 'admin', op: 'addRole', guild: 'guild', member: 'alice', role: 'ban' },
					{ kind: 'user', actor: 'alice', verb: 'slash', command: 'needs-role' },
				],
				arrival: [
					{ view: { actor: 'alice', channel: 'channel' }, contains: 'member ok' },
					{ view: { actor: 'bob', channel: 'channel' }, contains: 'member ok' },
					{ view: { actor: 'carol', channel: 'channel' }, contains: 'member ok', absent: true },
				],
			});
			expect(replayed.log.preset.refs?.alice).toBe('123456789012345678');
		} finally {
			await session.dispose();
		}
	});

	test('locators only see the actor conversation and observer failures are diagnosed', async () => {
		const session = createSession(project, preset);
		const observerErrors: string[] = [];
		session.observe(() => {
			throw new Error('observer broke');
		});
		session.observe(event => {
			if (event.type === 'error' && event.origin === 'observer') observerErrors.push(String(event.detail));
		});
		await session.start();
		try {
			for (const actor of ['alice', 'bob'])
				await session.act({ kind: 'user', actor, verb: 'slash', command: 'private-panel' });
			const alice = await session.view('alice', 'channel');
			const bob = await session.view('bob', 'channel');
			expect(alice.messages.filter(item => item.payload.content === 'private panel')).toHaveLength(1);
			expect(bob.messages.filter(item => item.payload.content === 'private panel')).toHaveLength(1);
			expect(alice.messages.at(-1)?.id).not.toBe(bob.messages.at(-1)?.id);
			for (const actor of ['alice', 'bob'])
				expect(
					(
						await session.act({
							kind: 'user',
							actor,
							verb: 'click',
							customId: 'private',
							source: { channel: 'channel', customId: 'private' },
						})
					).summary,
				).toContain('clicked:');
			expect(await session.view('carol', 'channel')).toMatchObject({ messages: [], diagnostics: ['no-view-channel'] });
			await expect(
				session.act({
					kind: 'user',
					actor: 'carol',
					verb: 'click',
					customId: 'private',
					source: { channel: 'channel', customId: 'private' },
				}),
			).rejects.toThrow('cannot view channel');
			expect(observerErrors[0]).toContain('observer broke');
			expect((await session.inspect()).diagnostics).toContain('Observer failed: observer broke');
		} finally {
			await session.dispose();
		}
	});

	test('protocol rejects unknown actions and missing payloads in parent and child', async () => {
		for (const action of [
			{ kind: 'missing' },
			{ kind: 'user', actor: 'alice', verb: 'other' },
			{ kind: 'user', actor: 'alice', verb: 'click', customId: 'x' },
		])
			expect(() => validateLabAction(action)).toThrow('Invalid protocol action');
		expect(() => validateBridgeRequest({ version: PROTOCOL_VERSION, id: 1, type: 'session.act' })).toThrow(
			'Invalid protocol action',
		);
		expect(isBridgeMessage({ version: PROTOCOL_VERSION, id: 1, type: 'session.nope' })).toBe(false);
		expect(isBridgeMessage({ version: PROTOCOL_VERSION, id: 1, type: 'result', ok: true })).toBe(false);
		expect(
			isBridgeMessage({
				version: PROTOCOL_VERSION,
				type: 'event',
				event: { type: 'rest', phase: 'other', detail: {} },
			}),
		).toBe(false);
		const worker = fork(resolve(process.cwd(), 'lib/child/worker.js'), [fixturePath, '5000'], {
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		try {
			for (const [id, type, payload, error] of [
				[7, 'session.act', { kind: 'user', actor: 'alice', verb: 'click', customId: 'x' }, 'action.source'],
				[8, 'session.act', { kind: 'user', actor: 'alice', verb: 'other' }, 'action.verb'],
				[9, 'session.nope', null, 'request type'],
			] as const) {
				const response = new Promise<unknown>(done => worker.once('message', done));
				worker.send({ version: PROTOCOL_VERSION, id, type, payload });
				expect(await response).toMatchObject({ id, ok: false, error: expect.stringContaining(error) });
			}
		} finally {
			worker.kill('SIGKILL');
		}
	});

	test('failed cleanup leaves in-process reset stopped', async () => {
		let setups = 0;
		const failing = defineProject({
			name: 'failing',
			scenarios: [defineScenario({ id: 'life', version: 1, title: 'Life' })],
			resources: {
				setup: () => {
					setups++;
					return {};
				},
				dispose: () => {
					throw new Error('cleanup failed; external cleanup may be pending');
				},
			},
			bot: () => ({}),
		});
		const session = createSession(failing, { scenario: { id: 'life', version: 1 } });
		await session.start();
		await expect(session.reset()).rejects.toThrow('Session cleanup failed');
		expect(setups).toBe(1);
		await expect(session.inspect()).rejects.toThrow('Session is not started');
	});

	test('child reset forks a fresh module and dispose waits for process exit', async () => {
		const child = createChildSession({
			projectModule: resolve(process.cwd(), 'test/fixtures/lifecycle.cjs'),
			preset: { scenario: { id: 'life', version: 1 } },
		});
		await child.start();
		const first = (await child.inspectProject('identity')) as { pid: number; moduleCount: number };
		try {
			await child.reset();
			const second = (await child.inspectProject('identity')) as { pid: number; moduleCount: number };
			expect(second.pid).not.toBe(first.pid);
			expect(second.moduleCount).toBe(1);
		} finally {
			await child.dispose();
		}
		expect(() => process.kill(first.pid, 0)).toThrow();
	});

	test.each([
		['exit times out', { LAB_HOLD_OPEN: '1' }],
		['cleanup fails', { LAB_CLEANUP_FAIL: '1' }],
	])('child reset does not start again when %s', async (_case, env) => {
		const child = createChildSession({
			projectModule: resolve(process.cwd(), 'test/fixtures/lifecycle.cjs'),
			preset: { scenario: { id: 'life', version: 1 } },
			env,
			disposeTimeoutMs: 100,
		});
		await child.start();
		const { pid } = (await child.inspectProject('identity')) as { pid: number };
		await expect(child.reset()).rejects.toThrow('external cleanup may be pending');
		await expect(child.inspectProject('identity')).rejects.toThrow('not running');
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
