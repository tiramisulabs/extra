import { type AnyContext, Cache, Client, Command, Logger, MemoryAdapter, SubCommand } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import { CommandHandler } from 'seyfert/lib/commands/handler.js';
import { TimestampStyle } from 'seyfert/lib/common';
import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';
import {
	Cooldown,
	CooldownManager,
	type CooldownProps,
	CooldownType,
	cooldown as cooldownPlugin,
	formatRemaining,
	runWithCooldownContext,
	useCooldownContext,
} from '../src';
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
		fullCommandName: 'testCommand',
		author: { id: 'user1' },
		guildId: 'guild1',
		channelId: 'channel1',
		...overrides,
	} as unknown as AnyContext;
}

class AtomicMemoryAdapter extends MemoryAdapter {
	evalCalls = 0;

	async eval(_script: string, keys: string[], args: string[]) {
		this.evalCalls++;
		const [hashKey, namespace] = keys;
		const [nowArg, intervalArg, limitArg, tokensArg, memberKey] = args;
		const now = Number(nowArg);
		const interval = Number(intervalArg);
		const limit = Number(limitArg);
		const tokens = Number(tokensArg);
		const data = this.get(hashKey) as CooldownData | null;

		if (tokens > limit) {
			return [0, -1, -1, limit, data?.remaining ?? limit, 2];
		}

		if (!data || now - data.lastDrip >= interval) {
			const remaining = limit - tokens;
			this.addToRelationship(namespace, memberKey);
			this.set(hashKey, { interval, remaining, lastDrip: now });
			return [1, 0, now, limit, remaining, 0];
		}

		const remainingMs = interval - (now - data.lastDrip);
		if (data.remaining - tokens < 0) {
			return [0, remainingMs, now + remainingMs, limit, data.remaining, 1];
		}

		const remaining = data.remaining - tokens;
		this.addToRelationship(namespace, memberKey);
		this.patch(hashKey, { interval, remaining });
		return [1, 0, now, limit, remaining, 0];
	}
}

describe('CooldownManager — getCommandData', () => {
	let client: Client;
	let manager: CooldownManager;
	let cooldownData: CooldownProps;

	beforeEach(() => {
		client = new Client({
			getRC: () => ({ debug: true, intents: 0, token: '', locations: { base: '', output: '' } }),
		});

		const handler = new CommandHandler(new Logger({ active: true }), client);
		cooldownData = { type: CooldownType.User, interval: 1000, uses: { default: 3 } };

		const groupedSubCommand = makeSub({
			name: 'testGroupSub',
			aliases: ['groupSubAlias'],
			group: 'admin',
			description: 'Grouped subcommand cooldown test',
		});

		handler.values = [
			makeCommand({
				name: 'aliasedCommand',
				aliases: ['aliasRoot'],
				description: 'Aliased command cooldown test',
				cooldown: cooldownData,
			}),
			makeCommand({
				name: 'commandWithfakeGuildId',
				description: 'Command with specific guild cooldown test',
				cooldown: cooldownData,
				guildId: ['124'],
			}),
			makeCommand({
				name: 'testCommand',
				aliases: ['testAlias'],
				cooldown: cooldownData,
				description: 'Root command cooldown test',
				groups: { admin: { description: 'Admin group' } },
				groupsAliases: { adm: 'admin' },
				options: [
					makeSub({
						name: 'testSub',
						aliases: ['subAlias'],
						cooldown: cooldownData,
						description: 'Subcommand cooldown test',
					}),
					makeSub({
						name: 'testSubNon',
						description: 'Subcommand without its own cooldown, should inherit from root',
					}),
					groupedSubCommand,
				],
			}),
		];

		client.commands = handler;
		client.handleCommand = new HandleCommand(client);
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		manager = new CooldownManager(client);
	});

	test('returns cooldown data for a root command', () => {
		assert.deepEqual(manager.getCommandData('testCommand'), ['testCommand', cooldownData]);
	});

	test('returns cooldown data for a subcommand using full name', () => {
		assert.deepEqual(manager.getCommandData('testCommand testSub'), ['testCommand testSub', cooldownData]);
	});

	test('resolves canonical names from aliases and groups', () => {
		assert.deepEqual(manager.getCommandData('aliasRoot'), ['aliasedCommand', cooldownData]);
		assert.deepEqual(manager.getCommandData('testAlias subAlias'), ['testCommand testSub', cooldownData]);
		assert.deepEqual(manager.getCommandData('testCommand adm groupSubAlias'), [
			'testCommand admin testGroupSub',
			cooldownData,
		]);
	});

	test('uses an overridden message resolver for shortcut compatibility', () => {
		const parent = client.commands!.values.find(command => command.name === 'testCommand') as Command;
		const command = parent.options!.find(
			option => option instanceof SubCommand && option.name === 'testGroupSub',
		) as SubCommand;

		class ShortcutHandleCommand extends HandleCommand {
			override resolveCommandFromContent(content: string, prefix: string, message: never) {
				if (content === 'shortcut') {
					return {
						parent,
						command,
						fullCommandName: 'testCommand admin testGroupSub',
						argsContent: '',
					};
				}
				return super.resolveCommandFromContent(content, prefix, message);
			}
		}

		client.handleCommand = new ShortcutHandleCommand(client);
		assert.deepEqual(manager.getCommandData('shortcut'), ['testCommand admin testGroupSub', cooldownData]);
	});

	test('falls back when an overridden resolver throws', () => {
		class ThrowingHandleCommand extends HandleCommand {
			override resolveCommandFromContent(): never {
				throw new Error('resolver failed');
			}
		}
		client.handleCommand = new ThrowingHandleCommand(client);
		assert.deepEqual(manager.getCommandData('testCommand'), ['testCommand', cooldownData]);
	});

	test('falls back when an overridden resolver returns nothing', () => {
		class EmptyHandleCommand extends HandleCommand {
			override resolveCommandFromContent() {
				return undefined as never;
			}
		}
		client.handleCommand = new EmptyHandleCommand(client);
		assert.deepEqual(manager.getCommandData('testCommand'), ['testCommand', cooldownData]);
	});

	test('returns undefined for subcommand if root is not provided', () => {
		assert.equal(manager.getCommandData('testSub'), undefined);
	});

	test('returns undefined for non-existent command', () => {
		assert.equal(manager.getCommandData('nonExistentCommand'), undefined);
	});

	test('returns parent cooldown for a subcommand without its own cooldown data', () => {
		assert.deepEqual(manager.getCommandData('testCommand testSubNon'), ['testCommand testSubNon', cooldownData]);
	});

	test('filters by guildId correctly', () => {
		assert.equal(manager.getCommandData('testCommand', '123')?.[0], 'testCommand');
		assert.equal(manager.getCommandData('testCommand testSub', '123')?.[0], 'testCommand testSub');
		assert.equal(manager.getCommandData('commandWithfakeGuildId', '123'), undefined);
		assert.equal(manager.getCommandData('commandWithfakeGuildId', '124')?.[0], 'commandWithfakeGuildId');
		assert.equal(manager.getCommandData('commandWithfakeGuildId')?.[0], 'commandWithfakeGuildId');
	});

	test('uses Seyfert parser guild candidates for metadata lookup without guildId', () => {
		class TrackingHandleCommand extends HandleCommand {
			guildIds: (string | undefined)[] = [];

			override resolveCommandFromContent(content: string, prefix: string, message: never) {
				this.guildIds.push((message as { guild_id?: string }).guild_id);
				return super.resolveCommandFromContent(content, prefix, message);
			}
		}

		const handle = new TrackingHandleCommand(client);
		client.handleCommand = handle;

		assert.equal(manager.getCommandData('commandWithfakeGuildId')?.[0], 'commandWithfakeGuildId');
		assert.deepEqual(handle.guildIds, [undefined, '124']);
	});
});

describe('CooldownManager — check / consume / remaining / reset', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		client = new Client({
			getRC: () => ({ debug: false, intents: 0, token: '', locations: { base: '', output: '' } }),
		});
		const handler = new CommandHandler(new Logger({ active: false }), client);
		handler.values = [
			makeCommand({
				name: 'ping',
				description: 'Ping',
				cooldown: { type: CooldownType.User, interval: 1_000, uses: { default: 2 } },
			}),
			makeCommand({
				name: 'unbounded',
				description: 'No cooldown configured',
			}),
		];
		client.commands = handler;
		client.handleCommand = new HandleCommand(client);
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		manager = new CooldownManager(client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('consume returns a rich CooldownResult on first call', async () => {
		const result = await manager.consume({ name: 'ping', target: 'u1' });
		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.remainingMs, 0);
		assert.equal(result.limit, 2);
		assert.equal(result.remainingUses, 1);
		assert.equal(result.key, 'ping:user:u1');
		assert.ok(result.retryAfter instanceof Date);
	});

	test('consume blocks once the bucket is exhausted', async () => {
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });
		const blocked = await manager.consume({ name: 'ping', target: 'u1' });
		assert.ok(blocked);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.reason, 'rate_limited');
		assert.equal(blocked.remainingUses, 0);
		assert.equal(blocked.remainingMs, 1_000);
		assert.equal(blocked.retryAfter.getTime(), 1_000);
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

	test('check reports post-consume counts with explicit token counts and existing buckets', async () => {
		const fresh = await manager.check({ name: 'ping', target: 'u1', tokens: 2 });
		assert.ok(fresh);
		assert.equal(fresh.allowed, true);
		assert.equal(fresh.remainingUses, 0);

		await manager.consume({ name: 'ping', target: 'u1' });
		const existing = await manager.check({ name: 'ping', target: 'u1' });
		assert.ok(existing);
		assert.equal(existing.allowed, true);
		assert.equal(existing.remainingUses, 0);

		const blocked = await manager.check({ name: 'ping', target: 'u1', tokens: 2 });
		assert.ok(blocked);
		assert.equal(blocked.allowed, false);
		assert.equal(blocked.remainingUses, 1);
	});

	test('remaining returns 0 when free and ms when blocked', async () => {
		assert.equal(await manager.remaining({ name: 'ping', target: 'u1' }), 0);
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });
		assert.equal(await manager.remaining({ name: 'ping', target: 'u1' }), 1_000);
	});

	test('reset clears the bucket', async () => {
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });
		const reset = await manager.reset('ping', 'u1');
		assert.equal(reset, true);
		const result = await manager.consume({ name: 'ping', target: 'u1' });
		assert.ok(result);
		assert.equal(result.allowed, true);
	});

	test('unknown use variant falls back to default limit and warns once', async () => {
		const warn = vi.fn();
		(client as Client & { debugger: { info: () => void; warn: typeof warn } }).debugger = {
			info: () => undefined,
			warn,
		};

		const result = await manager.consume({ name: 'ping', target: 'u1', use: 'missing' });

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.limit, 2);
		assert.equal(result.remainingUses, 1);
		assert.equal(manager.resource.get('ping:user:u1')?.remaining, 1);
		assert.equal(Number.isNaN(manager.resource.get('ping:user:u1')?.remaining), false);
		assert.equal(warn.mock.calls.length, 1);
	});

	test('reset with an unknown use variant restores the default bucket', async () => {
		await manager.consume({ name: 'ping', target: 'u1' });
		await manager.consume({ name: 'ping', target: 'u1' });

		const reset = await manager.reset('ping', 'u1', 'missing');
		const next = await manager.consume({ name: 'ping', target: 'u1' });

		assert.equal(reset, true);
		assert.ok(next);
		assert.equal(next.allowed, true);
		assert.equal(next.limit, 2);
		assert.equal(next.remainingUses, 1);
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

	test('tokens greater than limit is rejected without mutating', async () => {
		const result = await manager.consume({ name: 'ping', target: 'u1', tokens: 5 });
		assert.ok(result);
		assert.equal(result.allowed, false);
		assert.equal(result.reason, 'over_capacity');
		assert.equal(result.remainingMs, Infinity);
		assert.equal(result.retryAfter, null);
		assert.equal(manager.resource.get('ping:user:u1'), undefined);
	});

	test('check reports over-capacity without mutating', async () => {
		const result = await manager.check({ name: 'ping', target: 'u1', tokens: 5 });
		assert.ok(result);
		assert.equal(result.allowed, false);
		assert.equal(result.reason, 'over_capacity');
		assert.equal(result.remainingMs, Infinity);
		assert.equal(result.retryAfter, null);
		assert.equal(manager.resource.get('ping:user:u1'), undefined);
	});

	test('consume uses an atomic adapter path when eval is available', async () => {
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
		assert.equal(third.reason, 'rate_limited');
		assert.equal((adapter.get('cooldowns.ping:user:u1') as CooldownData | null)?.remaining, 0);
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

	test('returns undefined when the command resolves to no cooldown', async () => {
		assert.equal(await manager.consume({ name: 'unbounded', target: 'u1' }), undefined);
		assert.equal(await manager.check({ name: 'unbounded', target: 'u1' }), undefined);
		assert.equal(await manager.reset('unbounded', 'u1'), false);
	});
});

describe('CooldownManager — custom target resolver and shared groups', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		client = new Client({
			getRC: () => ({ debug: false, intents: 0, token: '', locations: { base: '', output: '' } }),
		});
		const handler = new CommandHandler(new Logger({ active: false }), client);

		handler.values = [
			makeCommand({
				name: 'custom',
				description: 'Custom resolver',
				cooldown: {
					type: () => 'static-target',
					interval: 1_000,
					uses: { default: 1 },
				},
			}),
			makeCommand({
				name: 'ban',
				description: 'Ban moderation command',
				cooldown: {
					type: CooldownType.User,
					interval: 1_000,
					uses: { default: 1 },
					group: 'mod',
				},
			}),
			makeCommand({
				name: 'kick',
				description: 'Kick moderation command',
				cooldown: {
					type: CooldownType.User,
					interval: 1_000,
					uses: { default: 1 },
					group: 'mod',
				},
			}),
			makeCommand({
				name: 'broadcast',
				description: 'Bot-wide cooldown',
				cooldown: {
					type: 'global',
					interval: 1_000,
					uses: { default: 1 },
				},
			}),
		];

		client.commands = handler;
		client.handleCommand = new HandleCommand(client);
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		manager = new CooldownManager(client);
	});

	test('custom resolver produces a "custom" type label in the key', async () => {
		const result = await manager.consume({ name: 'custom', target: 'static-target' });
		assert.ok(result);
		assert.equal(result.key, 'custom:custom:static-target');
	});

	test('shared group: two distinct commands share the same bucket', async () => {
		const first = await manager.consume({ name: 'ban', target: 'u1' });
		assert.ok(first);
		assert.equal(first.allowed, true);
		assert.equal(first.key, 'mod:user:u1');

		const second = await manager.consume({ name: 'kick', target: 'u1' });
		assert.ok(second);
		assert.equal(second.allowed, false);
		assert.equal(second.key, 'mod:user:u1');
	});

	test('global type collapses the cache key regardless of the supplied target', async () => {
		const first = await manager.consume({ name: 'broadcast', target: 'u1' });
		assert.ok(first);
		assert.equal(first.allowed, true);
		assert.equal(first.key, 'broadcast:global:global');

		const otherUser = await manager.consume({ name: 'broadcast', target: 'u2' });
		assert.ok(otherUser);
		assert.equal(otherUser.allowed, false);
		assert.equal(otherUser.key, 'broadcast:global:global');

		const peek = await manager.check({ name: 'broadcast', target: 'u999' });
		assert.ok(peek);
		assert.equal(peek.key, 'broadcast:global:global');

		const cleared = await manager.reset('broadcast', 'u-arbitrary');
		assert.equal(cleared, true);
		const afterReset = await manager.consume({ name: 'broadcast', target: 'u3' });
		assert.ok(afterReset);
		assert.equal(afterReset.allowed, true);
	});
});

describe('CooldownManager — context scope', () => {
	let client: Client;
	let manager: CooldownManager;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));

		client = new Client({
			getRC: () => ({ debug: false, intents: 0, token: '', locations: { base: '', output: '' } }),
		});
		const handler = new CommandHandler(new Logger({ active: false }), client);
		handler.values = [
			makeCommand({
				name: 'commandWithfakeGuildId',
				description: 'Command with specific guild cooldown test',
				cooldown: { type: CooldownType.User, interval: 1_000, uses: { default: 3 } },
				guildId: ['124'],
			}),
			makeCommand({
				name: 'testCommand',
				description: 'Root command cooldown test',
				cooldown: { type: CooldownType.User, interval: 1_000, uses: { default: 3 } },
			}),
		];
		client.commands = handler;
		client.handleCommand = new HandleCommand(client);
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		manager = new CooldownManager(client);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('context still accepts an explicit command context', async () => {
		const result = await manager.context(commandContext());

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.key, 'testCommand:user:user1');
		assert.equal(manager.resource.get('testCommand:user:user1')?.remaining, 2);
	});

	test('context throws a clear error when called without an active cooldown scope', () => {
		assert.throws(() => manager.context(), /outside of a Seyfert cooldown scope/);
	});

	test('context uses the current scoped command context when omitted', async () => {
		const result = await runWithCooldownContext(commandContext(), async () => manager.context());

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.key, 'testCommand:user:user1');
		assert.equal(manager.resource.get('testCommand:user:user1')?.remaining, 2);
	});

	test('context accepts scoped options without manually passing the context', async () => {
		const result = await runWithCooldownContext(
			commandContext({ fullCommandName: 'commandWithfakeGuildId' }),
			async () => manager.context({ guildId: '124' }),
		);

		assert.ok(result);
		assert.equal(result.allowed, true);
		assert.equal(result.key, 'commandWithfakeGuildId:user:user1');
		assert.equal(manager.resource.get('commandWithfakeGuildId:user:user1')?.remaining, 2);
	});
});

describe('Cooldown decorator shortcuts', () => {
	test('Cooldown.user assigns a user-scoped CooldownProps', () => {
		@Cooldown.user(5_000)
		class Cmd {}
		const props = (new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown;
		assert.equal(props.type, 'user');
		assert.equal(props.interval, 5_000);
		assert.deepEqual(props.uses, { default: 1 });
	});

	test('Cooldown.guild / .channel / .global emit correct type', () => {
		@Cooldown.guild(1_000, { default: 3 })
		class G {}
		@Cooldown.channel(1_000)
		class C {}
		@Cooldown.global(1_000)
		class Gl {}
		assert.equal((new G() as G & { cooldown: CooldownProps }).cooldown.type, 'guild');
		assert.equal((new G() as G & { cooldown: CooldownProps }).cooldown.uses.default, 3);
		assert.equal((new C() as C & { cooldown: CooldownProps }).cooldown.type, 'channel');
		assert.equal((new Gl() as Gl & { cooldown: CooldownProps }).cooldown.type, 'global');
	});

	test('Cooldown.user accepts a shared group via extras', () => {
		@Cooldown.user(1_000, { default: 1 }, { group: 'mod' })
		class Cmd {}
		assert.equal((new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown.group, 'mod');
	});

	test('Cooldown.custom assigns a resolver function as type', () => {
		const resolver = () => 'k';
		@Cooldown.custom(resolver, 1_000)
		class Cmd {}
		assert.equal((new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown.type, resolver);
	});

	test('Cooldown.custom accepts a shared group via extras', () => {
		const resolver = () => 'k';
		@Cooldown.custom(resolver, 1_000, undefined, { group: 'mod' })
		class Cmd {}
		assert.equal((new Cmd() as Cmd & { cooldown: CooldownProps }).cooldown.group, 'mod');
	});
});

describe('formatRemaining', () => {
	test('returns "0s" for non-positive values', () => {
		assert.equal(formatRemaining(0), '0s');
		assert.equal(formatRemaining(-100), '0s');
		assert.equal(formatRemaining(Number.NaN), '0s');
	});

	test('returns seconds-only strings under one minute', () => {
		assert.equal(formatRemaining(500), '1s');
		assert.equal(formatRemaining(5_000), '5s');
		assert.equal(formatRemaining(59_000), '59s');
	});

	test('returns minute/second strings under one hour', () => {
		assert.equal(formatRemaining(60_000), '1m');
		assert.equal(formatRemaining(90_000), '1m 30s');
	});

	test('returns hour/minute strings beyond one hour', () => {
		assert.equal(formatRemaining(3_600_000), '1h');
		assert.equal(formatRemaining(3_660_000), '1h 1m');
	});

	test('accepts an absolute Date input', () => {
		const target = new Date(Date.now() + 5_000);
		assert.equal(formatRemaining(target), '5s');
	});

	test('discord mode emits a Formatter.timestamp tag using TimestampStyle.RelativeTime by default', () => {
		assert.equal(formatRemaining(5_000, { style: 'discord', now: () => 0 }), '<t:5:R>');
	});

	test('discord mode honors a custom TimestampStyle', () => {
		assert.equal(
			formatRemaining(5_000, { style: 'discord', discordStyle: TimestampStyle.ShortTime, now: () => 0 }),
			'<t:5:t>',
		);
	});

	test('discord mode accepts a Date input', () => {
		assert.equal(formatRemaining(new Date(0), { style: 'discord' }), '<t:0:R>');
	});
});

describe('cooldown() plugin', () => {
	test('builds a plugin with manager and seyfert lifecycle hooks', async () => {
		const plugin = cooldownPlugin();
		assert.equal(plugin.name, '@slipher/cooldown');
		assert.ok(plugin.manager instanceof CooldownManager);
		assert.equal(typeof plugin.setup, 'function');
		assert.equal(typeof plugin.options, 'function');

		const options = plugin.options();
		const ctx = options.context();
		assert.equal(ctx.cooldown, plugin.manager);

		const scope = options.contextScopes[0];
		assert.equal(typeof scope, 'function');
		await scope(commandContext(), async () => {
			assert.equal(useCooldownContext().fullCommandName, 'testCommand');
		});
	});

	test('setup attaches the manager to the client', () => {
		const plugin = cooldownPlugin();
		const client = new Client({
			getRC: () => ({ debug: false, intents: 0, token: '', locations: { base: '', output: '' } }),
		});
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		plugin.setup(client);
		assert.equal((client as Client & { cooldown: CooldownManager }).cooldown, plugin.manager);
	});
});
