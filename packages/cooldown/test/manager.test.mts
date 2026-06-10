import { type AnyContext, Cache, Client, Command, Logger, MemoryAdapter, SubCommand } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import { CommandHandler } from 'seyfert/lib/commands/handler.js';
import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import { Cooldown, CooldownManager, type CooldownProps, cooldown as cooldownPlugin } from '../src';
import type { CooldownData } from '../src/resource';

function makeCommand(overrides: Record<string, unknown>) {
	return Object.assign(new (class extends Command {})(), overrides);
}

function makeSub(overrides: Record<string, unknown>) {
	return Object.assign(new (class extends SubCommand {})(), overrides);
}

function commandContext(overrides: Record<string, unknown> = {}) {
	return {
		command: {},
		fullCommandName: 'ping',
		author: { id: 'user1' },
		guildId: 'guild1',
		channelId: 'channel1',
		...overrides,
	} as unknown as AnyContext;
}

function createClient(commands: Command[] = []) {
	const client = new Client({
		getRC: () => ({ debug: false, intents: 0, token: '', locations: { base: '', output: '' } }),
	});
	const handler = new CommandHandler(new Logger({ active: false }), client);
	handler.values = commands;
	client.commands = handler;
	client.handleCommand = new HandleCommand(client);
	client.cache = new Cache(0, new MemoryAdapter(), {}, client);
	return client;
}

function createScopedPlugin(client: Client, plugin = cooldownPlugin()) {
	const fragments: Array<{ contextScopes?: readonly ((context: AnyContext, run: () => unknown) => unknown)[] }> = [];
	plugin.register?.({
		options: {
			set(fragment) {
				fragments.push(fragment as (typeof fragments)[number]);
			},
		},
	} as never);
	plugin.setup(client);

	const scope = fragments[0]?.contextScopes?.[0];
	if (!scope) throw new Error('Missing cooldown context scope');
	return { plugin, scope };
}

class AtomicMemoryAdapter extends MemoryAdapter {
	readonly supportsAtomicCooldowns = true;
	evalCalls = 0;

	async eval(_script: string, keys: string[], args: string[]) {
		this.evalCalls++;
		const [hashKey, namespace] = keys;
		const [intervalArg, limitArg, costArg, memberKey] = args;
		const now = Date.now();
		const interval = Number(intervalArg);
		const limit = Number(limitArg);
		const cost = Number(costArg);
		const data = this.get(hashKey) as CooldownData | null;

		if (!data || now - data.lastDrip >= interval) {
			const remaining = limit - cost;
			this.addToRelationship(namespace, memberKey);
			this.set(hashKey, { interval, remaining, lastDrip: now });
			return [1, 0, now, limit, remaining];
		}

		const remainingMs = interval - (now - data.lastDrip);
		if (data.remaining - cost < 0) {
			return [0, remainingMs, now + remainingMs, limit, data.remaining];
		}

		const remaining = data.remaining - cost;
		this.addToRelationship(namespace, memberKey);
		this.patch(hashKey, { interval, remaining });
		return [1, 0, now, limit, remaining];
	}
}

class EvalOnlyMemoryAdapter extends MemoryAdapter {
	evalCalls = 0;

	async eval() {
		this.evalCalls++;
		throw new Error('eval should not be used without an explicit cooldown atomic opt-in');
	}
}

describe('CooldownManager — explicit check / consume / reset', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		client = createClient([
			makeCommand({
				name: 'guildOnly',
				description: 'Guild command',
				cooldown: { type: 'user', interval: 1_000, uses: 2 },
				guildId: ['124'],
			}),
			makeCommand({
				name: 'ping',
				description: 'Ping',
				cooldown: { type: 'user', interval: 1_000, uses: 2 },
			}),
			makeCommand({
				name: 'unbounded',
				description: 'No cooldown configured',
			}),
		]);
		manager = new CooldownManager(client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('consume returns a rich result without a reason field', async () => {
		const result = await manager.consume({ name: 'ping', target: 'u1' });

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.remainingMs, 0);
		assert.equal(result.limit, 2);
		assert.equal(result.remainingUses, 1);
		assert.equal(result.key, 'ping:user:u1');
		assert.ok(result.retryAfter instanceof Date);
		assert.equal('reason' in result, false);
	});

	test('consume blocks once the bucket is exhausted', async () => {
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });
		const blocked = await manager.consume({ name: 'ping', target: 'u1' });

		assert.ok(blocked);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.remainingUses, 0);
		assert.equal(blocked.remainingMs, 1_000);
		assert.equal(blocked.retryAfter.getTime(), 1_000);
		assert.equal('reason' in blocked, false);
	});

	test('check does not mutate bucket state and reports post-consume counts', async () => {
		const before = await manager.check({ name: 'ping', target: 'u1' });
		const after = await manager.check({ name: 'ping', target: 'u1' });

		assert.ok(before && after);
		assert.equal(before.allowed, true);
		assert.equal(before.remainingUses, 1);
		assert.equal(after.remainingUses, 1);
		assert.equal(manager.resource.get('ping:user:u1'), undefined);
	});

	test('throws RangeError when cost exceeds the limit without mutating', () => {
		assert.throws(() => manager.consume({ name: 'ping', target: 'u1', cost: 5 }), RangeError);
		assert.throws(() => manager.check({ name: 'ping', target: 'u1', cost: 5 }), RangeError);
		assert.equal(manager.resource.get('ping:user:u1'), undefined);
	});

	test('consume and check accept a multi-use cost', async () => {
		const preview = await manager.check({ name: 'ping', target: 'u1', cost: 2 });
		const consumed = await manager.consume({ name: 'ping', target: 'u1', cost: 2 });
		const blocked = await manager.consume({ name: 'ping', target: 'u1' });

		assert.ok(preview && consumed && blocked);
		assert.equal(preview.allowed, true);
		assert.equal(preview.remainingUses, 0);
		assert.equal(consumed.allowed, true);
		assert.equal(consumed.remainingUses, 0);
		assert.equal(blocked.allowed, false);
	});

	test('reset deletes the bucket and accepts guildId in the explicit form', async () => {
		await manager.consume({ name: 'guildOnly', target: 'u1', guildId: '124' });
		await manager.consume({ name: 'guildOnly', target: 'u1', guildId: '124' });

		const reset = await manager.reset({ name: 'guildOnly', target: 'u1', guildId: '124' });
		const afterReset = await manager.consume({ name: 'guildOnly', target: 'u1', guildId: '124' });

		assert.equal(reset, true);
		assert.equal(manager.resource.get('guildOnly:user:u1')?.remaining, 1);
		assert.ok(afterReset);
		assert.equal(afterReset.allowed, true);
	});

	test('explicit form does not scan guild-specific commands without guildId', async () => {
		assert.equal(await manager.consume({ name: 'guildOnly', target: 'u1' }), undefined);
		assert.equal(await manager.consume({ name: 'guildOnly', target: 'u1', guildId: '123' }), undefined);
		assert.ok(await manager.consume({ name: 'guildOnly', target: 'u1', guildId: '124' }));
	});

	test('consume refills after the interval elapses', async () => {
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });
		vi.advanceTimersByTime(1_500);
		const result = await manager.consume({ name: 'ping', target: 'u1' });

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.remainingUses, 1);
	});

	test('returns undefined when the command resolves to no cooldown', async () => {
		assert.equal(await manager.consume({ name: 'unbounded', target: 'u1' }), undefined);
		assert.equal(await manager.check({ name: 'unbounded', target: 'u1' }), undefined);
		assert.equal(await manager.reset({ name: 'unbounded', target: 'u1' }), false);
	});
});

describe('CooldownManager — implicit scoped check / consume / reset', () => {
	let client: Client;
	let command: Command;
	let manager: CooldownManager;
	let scope: (context: AnyContext, run: () => unknown) => unknown;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		command = makeCommand({
			name: 'ping',
			description: 'Ping',
			cooldown: { type: 'user', interval: 1_000, uses: 3 },
		});
		client = createClient([command]);
		const pluginSetup = createScopedPlugin(client);
		manager = pluginSetup.plugin.manager;
		scope = pluginSetup.scope;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('zero-arg verbs throw outside a cooldown scope and point to the explicit form', () => {
		assert.throws(() => manager.consume(), /Use the explicit/);
		assert.throws(() => manager.check(), /Use the explicit/);
		assert.throws(() => manager.reset(), /Use the explicit/);
	});

	test('consume uses the active command context without re-resolving by name', async () => {
		client.handleCommand = {
			resolveCommandFromContent() {
				throw new Error('implicit path should not resolve the command by name');
			},
			getCommandFromContent() {
				throw new Error('implicit path should not resolve the command by name');
			},
		} as never;

		const result = await scope(commandContext({ client, command, fullCommandName: 'ping' }), () => manager.consume());

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.key, 'ping:user:user1');
		assert.equal(manager.resource.get('ping:user:user1')?.remaining, 2);
	});

	test('implicit check and reset use the active context target', async () => {
		const context = commandContext({ client, command, fullCommandName: 'ping' });
		await scope(context, () => manager.consume());
		const peek = await scope(context, () => manager.check());
		const reset = await scope(context, () => manager.reset());
		const afterReset = await scope(context, () => manager.consume());

		assert.ok(peek);
		assert.equal(peek.remainingUses, 1);
		assert.equal(reset, true);
		assert.ok(afterReset);
		assert.equal(afterReset.allowed, true);
		assert.equal(afterReset.remainingUses, 2);
	});

	test('implicit path falls back to parent cooldown only when a subcommand has no props', async () => {
		const child = makeSub({
			name: 'child',
			description: 'Subcommand without cooldown',
		});
		const parent = makeCommand({
			name: 'parent',
			description: 'Parent',
			cooldown: { type: 'user', interval: 1_000, uses: 1 },
			options: [child],
		});
		client = createClient([parent]);
		const pluginSetup = createScopedPlugin(client);
		manager = pluginSetup.plugin.manager;
		scope = pluginSetup.scope;

		const result = await scope(commandContext({ client, command: child, fullCommandName: 'parent child' }), () =>
			manager.consume(),
		);

		assert.ok(result);
		assert.equal(result.key, 'parent child:user:user1');
	});

	test('implicit path defaults guildId from the active context', async () => {
		const guildOnly = makeCommand({
			name: 'guildOnly',
			description: 'Guild command',
			cooldown: { type: 'user', interval: 1_000, uses: 1 },
			guildId: ['124'],
		});
		client = createClient([guildOnly]);
		const pluginSetup = createScopedPlugin(client);
		manager = pluginSetup.plugin.manager;
		scope = pluginSetup.scope;

		const result = await scope(
			commandContext({ client, command: guildOnly, fullCommandName: 'guildOnly', guildId: '124' }),
			() => manager.consume(),
		);

		assert.ok(result);
		assert.equal(result.key, 'guildOnly:user:user1');
	});
});

describe('CooldownManager — custom target resolver, shared groups, and targets', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		client = createClient([
			makeCommand({
				name: 'custom',
				description: 'Custom resolver',
				cooldown: {
					type: () => 'static-target',
					interval: 1_000,
				},
			}),
			makeCommand({
				name: 'ban',
				description: 'Ban moderation command',
				cooldown: {
					type: 'user',
					interval: 1_000,
					group: 'mod',
				},
			}),
			makeCommand({
				name: 'kick',
				description: 'Kick moderation command',
				cooldown: {
					type: 'user',
					interval: 1_000,
					group: 'mod',
				},
			}),
			makeCommand({
				name: 'broadcast',
				description: 'Bot-wide cooldown',
				cooldown: {
					type: 'global',
					interval: 1_000,
				},
			}),
			makeCommand({
				name: 'guildTarget',
				description: 'Guild target fallback',
				cooldown: {
					type: 'guild',
					interval: 1_000,
				},
			}),
			makeCommand({
				name: 'channelTarget',
				description: 'Channel target fallback',
				cooldown: {
					type: 'channel',
					interval: 1_000,
				},
			}),
		]);
		manager = new CooldownManager(client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('custom resolver produces a custom type label in the key for scoped consumes', async () => {
		const { plugin, scope } = createScopedPlugin(client);
		manager = plugin.manager;
		const command = client.commands!.values.find(item => item.name === 'custom')!;

		const result = await scope(commandContext({ client, command, fullCommandName: 'custom' }), () => manager.consume());

		assert.ok(result);
		assert.equal(result.key, 'custom:custom:static-target');
	});

	test('shared group: two distinct commands share the same bucket', async () => {
		const first = await manager.consume({ name: 'ban', target: 'u1' });
		const second = await manager.consume({ name: 'kick', target: 'u1' });

		assert.ok(first && second);
		assert.equal(first.allowed, true);
		assert.equal(first.key, 'mod:user:u1');
		assert.equal(second.allowed, false);
		assert.equal(second.key, 'mod:user:u1');
	});

	test('global type collapses the cache key regardless of supplied target', async () => {
		const first = await manager.consume({ name: 'broadcast', target: 'u1' });
		const otherUser = await manager.consume({ name: 'broadcast', target: 'u2' });
		const reset = await manager.reset({ name: 'broadcast', target: 'u-arbitrary' });
		const afterReset = await manager.consume({ name: 'broadcast', target: 'u3' });

		assert.ok(first && otherUser && afterReset);
		assert.equal(first.allowed, true);
		assert.equal(first.key, 'broadcast:global:global');
		assert.equal(otherUser.allowed, false);
		assert.equal(otherUser.key, 'broadcast:global:global');
		assert.equal(reset, true);
		assert.equal(afterReset.allowed, true);
	});

	test('guild and channel targets fall back to author id in DMs', async () => {
		const { plugin, scope } = createScopedPlugin(client);
		manager = plugin.manager;
		const guildCommand = client.commands!.values.find(item => item.name === 'guildTarget')!;
		const channelCommand = client.commands!.values.find(item => item.name === 'channelTarget')!;

		const guildResult = await scope(
			commandContext({ client, command: guildCommand, fullCommandName: 'guildTarget', guildId: undefined }),
			() => manager.consume(),
		);
		const channelResult = await scope(
			commandContext({
				client,
				command: channelCommand,
				fullCommandName: 'channelTarget',
				channelId: undefined,
			}),
			() => manager.consume(),
		);

		assert.ok(guildResult && channelResult);
		assert.equal(guildResult.key, 'guildTarget:guild:user1');
		assert.equal(channelResult.key, 'channelTarget:channel:user1');
	});
});

describe('CooldownManager — atomic storage', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		client = createClient([
			makeCommand({
				name: 'ping',
				description: 'Ping',
				cooldown: { type: 'user', interval: 1_000, uses: 2 },
			}),
		]);
		manager = new CooldownManager(client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('consume uses an atomic adapter path when the adapter opts in', async () => {
		const adapter = new AtomicMemoryAdapter();
		client.cache = new Cache(0, adapter, {}, client);
		manager = new CooldownManager(client);

		const first = await manager.consume({ name: 'ping', target: 'u1' });
		const second = await manager.consume({ name: 'ping', target: 'u1' });
		const third = await manager.consume({ name: 'ping', target: 'u1' });

		assert.equal(adapter.evalCalls, 3);
		assert.ok(first && second && third);
		assert.equal(first.allowed, true);
		assert.equal(second.allowed, true);
		assert.equal(third.allowed, false);
		assert.equal((adapter.get('cooldowns.ping:user:u1') as CooldownData | null)?.remaining, 0);
	});

	test('consume does not use eval without an explicit atomic opt-in', async () => {
		const adapter = new EvalOnlyMemoryAdapter();
		client.cache = new Cache(0, adapter, {}, client);
		manager = new CooldownManager(client);

		const result = await manager.consume({ name: 'ping', target: 'u1' });

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.remainingUses, 1);
		assert.equal(adapter.evalCalls, 0);
		assert.equal((adapter.get('cooldowns.ping:user:u1') as CooldownData | null)?.remaining, 1);
		assert.equal(adapter.contains('cooldowns', 'ping:user:u1'), true);
	});

	test('atomic adapter path does not overspend under concurrent consumes', async () => {
		const adapter = new AtomicMemoryAdapter();
		client.cache = new Cache(0, adapter, {}, client);
		manager = new CooldownManager(client);

		const results = await Promise.all(Array.from({ length: 5 }, () => manager.consume({ name: 'ping', target: 'u1' })));
		const allowed = results.filter(result => result?.allowed);
		const blocked = results.filter(result => result && !result.allowed);

		assert.equal(adapter.evalCalls, 5);
		assert.equal(allowed.length, 2);
		assert.equal(blocked.length, 3);
		assert.deepEqual(
			allowed.map(result => result?.remainingUses),
			[1, 0],
		);
		assert.equal((adapter.get('cooldowns.ping:user:u1') as CooldownData | null)?.remaining, 0);
	});
});

describe('Cooldown decorator shortcuts', () => {
	test('Cooldown.user assigns user-scoped props with one default use', () => {
		@Cooldown.user(5_000)
		class Cmd {}

		const props = (new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown;
		assert.equal(props.type, 'user');
		assert.equal(props.interval, 5_000);
		assert.equal(props.uses, 1);
	});

	test('Cooldown.guild / .channel / .global emit correct types', () => {
		@Cooldown.guild(1_000, { uses: 3 })
		class G {}
		@Cooldown.channel(1_000)
		class C {}
		@Cooldown.global(1_000)
		class Gl {}

		assert.equal((new G() as G & { cooldown: CooldownProps }).cooldown.type, 'guild');
		assert.equal((new G() as G & { cooldown: CooldownProps }).cooldown.uses, 3);
		assert.equal((new C() as C & { cooldown: CooldownProps }).cooldown.type, 'channel');
		assert.equal((new Gl() as Gl & { cooldown: CooldownProps }).cooldown.type, 'global');
	});

	test('Cooldown.user accepts a shared group in the options bag', () => {
		@Cooldown.user(1_000, { uses: 1, group: 'mod' })
		class Cmd {}

		assert.equal((new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown.group, 'mod');
	});

	test('Cooldown.custom assigns a resolver and accepts a shared group', () => {
		const resolver = () => 'k';

		@Cooldown.custom(resolver, 1_000, { group: 'mod' })
		class Cmd {}

		const props = (new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown;
		assert.equal(props.type, resolver);
		assert.equal(props.group, 'mod');
	});
});

describe('cooldown() plugin', () => {
	function createClientForPlugin(cooldownData: CooldownProps) {
		const command = makeCommand({
			name: 'testCommand',
			description: 'Command with cooldown',
			cooldown: cooldownData,
		});
		const client = createClient([command]);
		return { client, command };
	}

	test('builds a plugin with manager and seyfert lifecycle hooks', async () => {
		const plugin = cooldownPlugin();
		assert.equal(plugin.name, '@slipher/cooldown');
		assert.ok(plugin.manager instanceof CooldownManager);
		assert.equal(typeof plugin.setup, 'function');
		assert.equal(typeof plugin.client?.cooldown, 'function');
		assert.equal(typeof plugin.ctx?.cooldown, 'function');
		assert.equal(typeof plugin.register, 'function');

		assert.equal(plugin.client?.cooldown({} as never), plugin.manager);
		assert.equal(plugin.ctx?.cooldown({} as never, {} as never), plugin.manager);

		const { client, command } = createClientForPlugin({ interval: 1_000 });
		const { scope } = createScopedPlugin(client, plugin);
		const result = await scope(commandContext({ client, command, fullCommandName: 'testCommand' }), () =>
			plugin.manager.consume(),
		);

		assert.ok(result);
		assert.equal(result.key, 'testCommand:user:user1');
	});

	test('does not register a middleware by default', () => {
		const plugin = cooldownPlugin();
		const middlewares: unknown[] = [];

		plugin.register?.({
			middlewares: { add: (...args: unknown[]) => middlewares.push(args) },
			options: { set() {} },
		} as never);

		assert.deepEqual(middlewares, []);
	});

	test('registers an optional middleware that consumes the active context cooldown', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(0));
			const plugin = cooldownPlugin({
				middleware: {
					global: true,
					message: (result, context) => `${context.fullCommandName}:${result.remainingMs}`,
					name: 'commandCooldown',
				},
			});
			const registered: {
				middleware: (payload: {
					context: AnyContext;
					next: (result?: unknown) => void;
					pass: () => void;
					stop: (message: string) => void;
				}) => unknown;
				name: string;
				options?: { global?: boolean };
			}[] = [];
			const fragments: Array<{ contextScopes?: readonly ((context: AnyContext, run: () => unknown) => unknown)[] }> =
				[];

			plugin.register?.({
				middlewares: {
					add(name, middleware, options) {
						registered.push({ name, middleware, options });
					},
				},
				options: {
					set(fragment) {
						fragments.push(fragment as (typeof fragments)[number]);
					},
				},
			} as never);

			assert.equal(registered.length, 1);
			assert.equal(registered[0]?.name, 'commandCooldown');
			assert.deepEqual(registered[0]?.options, { global: true });

			const { client, command } = createClientForPlugin({
				interval: 1_000,
				type: 'user',
			});
			plugin.setup(client);
			const context = commandContext({ client, command, fullCommandName: 'testCommand' });
			const nextCalls: unknown[] = [];
			const stops: string[] = [];
			const scope = fragments[0]!.contextScopes![0]!;

			await scope(context, () =>
				registered[0]!.middleware({
					context,
					next: result => nextCalls.push(result),
					pass: () => {
						throw new Error('cooldown middleware should not pass');
					},
					stop: message => stops.push(message),
				}),
			);
			await scope(context, () =>
				registered[0]!.middleware({
					context,
					next: result => nextCalls.push(result),
					pass: () => {
						throw new Error('cooldown middleware should not pass');
					},
					stop: message => stops.push(message),
				}),
			);

			assert.equal(nextCalls.length, 1);
			assert.equal((nextCalls[0] as { allowed: boolean }).allowed, true);
			assert.deepEqual(stops, ['testCommand:1000']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('uses a friendly default cooldown middleware message', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date(0));
			const plugin = cooldownPlugin({ middleware: true });
			const registered: {
				middleware: (payload: {
					context: AnyContext;
					next: (result?: unknown) => void;
					pass: () => void;
					stop: (message: string) => void;
				}) => unknown;
				name: string;
				options?: { global?: boolean };
			}[] = [];
			const fragments: Array<{ contextScopes?: readonly ((context: AnyContext, run: () => unknown) => unknown)[] }> =
				[];

			plugin.register?.({
				middlewares: {
					add(name, middleware, options) {
						registered.push({ name, middleware, options });
					},
				},
				options: {
					set(fragment) {
						fragments.push(fragment as (typeof fragments)[number]);
					},
				},
			} as never);

			assert.equal(registered.length, 1);
			assert.equal(registered[0]?.name, 'cooldown');
			assert.equal(registered[0]?.options, undefined);

			const { client, command } = createClientForPlugin({
				interval: 1_000,
				type: 'user',
			});
			plugin.setup(client);
			const context = commandContext({ client, command, fullCommandName: 'testCommand' });
			const stops: string[] = [];
			const scope = fragments[0]!.contextScopes![0]!;

			await scope(context, () =>
				registered[0]!.middleware({
					context,
					next: () => {},
					pass: () => {
						throw new Error('cooldown middleware should not pass');
					},
					stop: message => stops.push(message),
				}),
			);
			await scope(context, () =>
				registered[0]!.middleware({
					context,
					next: () => {},
					pass: () => {
						throw new Error('cooldown middleware should not pass');
					},
					stop: message => stops.push(message),
				}),
			);

			assert.deepEqual(stops, ['This command is cooling down. Try again <t:1:R>.']);
		} finally {
			vi.useRealTimers();
		}
	});

	test('setup attaches the manager to the client', () => {
		const plugin = cooldownPlugin();
		const client = createClient();
		plugin.setup(client);
		assert.equal((client as Client & { cooldown: CooldownManager }).cooldown, plugin.manager);
	});
});
