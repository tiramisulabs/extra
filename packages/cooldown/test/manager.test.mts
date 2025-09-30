import { Cache, Client, Logger, MemoryAdapter } from 'seyfert';
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
				locations: {
					base: '',
					output: '',
				},
			}),
		});

		const handler = new CommandHandler(new Logger({ active: true }), client);
		cooldownData = {
			type: CooldownType.User,
			interval: 1000,
			uses: {
				default: 3,
			},
		};
		handler.values = [
			// @ts-expect-error
			{
				name: 'commandWithfakeGuildId',
				description: 'aaaa',
				cooldown: cooldownData,
				guildId: [],
			},
			{
				name: 'testCommand',
				description: 'aaaa',
				cooldown: cooldownData,
				options: [
					// @ts-expect-error
					{
						name: 'testSub',
						description: 'aaa',
						cooldown: cooldownData,
					},
					// @ts-expect-error
					{
						name: 'testSubNon',
						description: 'aaa',
					},
				],
			},
		];

		client.commands = handler;

		client.cache = new Cache(0, new MemoryAdapter(), {}, client);
		cooldownManager = new CooldownManager(client);
	});

	test('Data should return cooldown data for a command', () => {
		const data = cooldownManager.getCommandData('testCommand');
		assert.deepEqual(data, [
			'testCommand',
			{
				type: CooldownType.User,
				interval: 1000,
				uses: {
					default: 3,
				},
			},
		]);
	});

	test('Data should return cooldown data for a subcommand', () => {
		const data = cooldownManager.getCommandData('testSub');
		assert.deepEqual(data, [
			'testSub',
			{
				type: CooldownType.User,
				interval: 1000,
				uses: {
					default: 3,
				},
			},
		]);
	});

	test('Data should return undefined for non-existent command', () => {
		const data = cooldownManager.getCommandData('nonExistentCommand');
		assert.equal(data, undefined);
	});

	test('Data should return cooldown data parent for a non-existent subcommand', () => {
		const data = cooldownManager.getCommandData('testSub');
		assert.deepEqual(data, [
			'testSub',
			{
				type: CooldownType.User,
				interval: 1000,
				uses: {
					default: 3,
				},
			},
		]);
	});

	test('Data should return cooldown data parent for a subcommand without cooldown data ', () => {
		const data = cooldownManager.getCommandData('testSubNon');
		assert.deepEqual(data, [
			'testSubNon',
			{
				type: CooldownType.User,
				interval: 1000,
				uses: {
					default: 3,
				},
			},
		]);
	});

	test('has should return false for a new cooldown', () => {
		const result = cooldownManager.has({
			name: 'testCommand',
			target: 'user1',
		});
		assert.equal(result, false);
	});

	test('has should return true when cooldown is active', () => {
		for (let i = 0; i < cooldownData.uses.default; i++) {
			cooldownManager.use({
				name: 'testCommand',
				target: 'user1',
			});
		}
		const result = cooldownManager.has({
			name: 'testCommand',
			target: 'user1',
		});
		assert.equal(result, true);
	});

	test('use should set cooldown when used for the first time', () => {
		const result = cooldownManager.use({
			name: 'testCommand',
			target: 'user2',
		});
		assert.equal(result, true);
	});

	test('use should return time left when cooldown is active', () => {
		for (let i = 0; i < cooldownData.uses.default; i++) {
			cooldownManager.use({
				name: 'testCommand',
				target: 'user3',
			});
		}
		const result = cooldownManager.use({
			name: 'testCommand',
			target: 'user3',
		});
		assert.ok(typeof result === 'number');
	});

	test('refill should refill the cooldown', () => {
		cooldownManager.use({
			name: 'testCommand',
			target: 'user1',
		});
		const result = cooldownManager.refill('testCommand', 'user1');
		assert.equal(result, true);
		assert.equal(
			cooldownManager.has({
				name: 'testCommand',
				target: 'user1',
			}),
			false,
		);
	});

	test('drip should drip the cooldown over time', async () => {
		cooldownManager.use({
			name: 'testCommand',
			target: 'user1',
		});

		// Simulate time passing
		await new Promise(resolve => setTimeout(resolve, 1000));

		const data = cooldownManager.resource.get('testCommand:user:user1');
		const props = cooldownManager.getCommandData('testCommand');
		await cooldownManager.drip({
			name: 'testCommand',
			target: 'user1',
			data: data!,
			props: props![1]!,
		});
		const getter = cooldownManager.resource.get('testCommand:user:user1');
		assert.ok(getter?.remaining === 2);
	});

	test('getCommandData should return undefined for a command with a fake guildId', () => {
		const shouldUndefined = cooldownManager.getCommandData('commandWithfakeGuildId', '123');
		const shouldNotUndefined = cooldownManager.getCommandData('commandWithfakeGuildId');
		assert.equal(shouldUndefined, undefined);
		console.log(shouldNotUndefined);
		assert.deepEqual(shouldNotUndefined, [
			'commandWithfakeGuildId',
			{
				type: 'user',
				interval: 1000,
				uses: {
					default: 3,
				},
			},
		]);
	});
});
