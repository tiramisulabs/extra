import { Cache, Client, Command, Logger, MemoryAdapter, SubCommand } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import { CommandHandler } from 'seyfert/lib/commands/handler.js';
import { assert, beforeEach, describe, test } from 'vitest';
import { CooldownManager, type CooldownProps, CooldownType } from '../lib';

describe('CooldownManager', async () => {
	let client: Client;
	let cooldownManager: CooldownManager;
	let cooldownData: CooldownProps;

	beforeEach(() => {
		client = new Client({
			getRC: () => ({
				debug: true,
				intents: 0,
				token: '',
				locations: { base: '', output: '' },
			}),
		});

		const handler = new CommandHandler(new Logger({ active: true }), client);
		cooldownData = {
			type: CooldownType.User,
			interval: 1000,
			uses: { default: 3 },
		};

		handler.values = [
			Object.assign(new (class extends Command {})(), {
				name: 'commandWithfakeGuildId',
				description: 'Command with specific guild cooldown test',
				cooldown: cooldownData,
				guildId: ['124'],
			}),
			Object.assign(new (class extends Command {})(), {
				name: 'testCommand',
				cooldown: cooldownData,
				description: 'Root command cooldown test',
				options: [
					// @ts-expect-error
					Object.assign(new (class extends SubCommand {})(), {
						name: 'testSub',
						cooldown: cooldownData,
						description: 'Subcommand cooldown test',
					}),
					// @ts-expect-error
					Object.assign(new (class extends SubCommand {})(), {
						name: 'testSubNon',
						description: 'Subcommand without its own cooldown, should inherit from root',
					}),
				],
			}),
		];

		client.commands = handler;
		client.handleCommand = new HandleCommand(client);
		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		cooldownManager = new CooldownManager(client);
	});

	test('Data should return cooldown data for a command', () => {
		const data = cooldownManager.getCommandData('testCommand');
		assert.deepEqual(data, ['testCommand', cooldownData]);
	});

	test('Data should return cooldown data for a subcommand using full name', () => {
		const data = cooldownManager.getCommandData('testCommand testSub');
		assert.deepEqual(data, ['testCommand testSub', cooldownData]);
	});

	test('Data should return undefined for subcommand if root is not provided (No Legacy)', () => {
		const data = cooldownManager.getCommandData('testSub');
		assert.equal(data, undefined);
	});

	test('Data should return undefined for non-existent command', () => {
		const data = cooldownManager.getCommandData('nonExistentCommand');
		assert.equal(data, undefined);
	});

	test('Data should return parent cooldown for a subcommand without its own cooldown data', () => {
		const data = cooldownManager.getCommandData('testCommand testSubNon');
		assert.deepEqual(data, ['testCommand testSubNon', cooldownData]);
	});

	test('has/use logic remains consistent with resolved names', () => {
		const commandName = 'testCommand';
		const target = 'user1';

		assert.equal(cooldownManager.has({ name: commandName, target }), false);

		for (let i = 0; i < cooldownData.uses.default; i++) {
			cooldownManager.use({ name: commandName, target });
		}

		assert.equal(cooldownManager.has({ name: commandName, target }), true);
		assert.ok(typeof cooldownManager.use({ name: commandName, target }) === 'number');
	});

	test('refill should clear the cooldown for resolved name', () => {
		cooldownManager.use({ name: 'testCommand', target: 'user1' });
		const result = cooldownManager.refill('testCommand', 'user1');

		assert.equal(result, true);
		assert.equal(cooldownManager.has({ name: 'testCommand', target: 'user1' }), false);
	});

	test('getCommandData handles guildId filtering correctly', () => {
		const shouldBeUndefined = cooldownManager.getCommandData('commandWithfakeGuildId', '123');
		const shouldBeFound = cooldownManager.getCommandData('commandWithfakeGuildId', '124');
		const shouldBeFoundWithoutGuild = cooldownManager.getCommandData('commandWithfakeGuildId');

		assert.equal(shouldBeUndefined, undefined);
		assert.equal(shouldBeFound?.[0], 'commandWithfakeGuildId');
		assert.equal(shouldBeFoundWithoutGuild?.[0], 'commandWithfakeGuildId');
	});

	test('drip should decrement remaining uses over time', async () => {
		const name = 'testCommand';
		const target = 'user1';

		cooldownManager.use({ name, target });

		await new Promise(resolve => setTimeout(resolve, 1050));

		const resource = cooldownManager.resource.get(`${name}:user:${target}`);
		const [resolvedName, props] = cooldownManager.getCommandData(name)!;

		await cooldownManager.drip({
			name,
			target,
			data: resource!,
			props: props!,
		});

		const updatedResource = cooldownManager.resource.get(`${name}:user:${target}`);

		assert.ok(updatedResource !== undefined);
	});
});
