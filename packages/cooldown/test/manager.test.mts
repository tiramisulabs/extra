import { Cache, Client, Logger, MemoryAdapter } from 'seyfert';
import { CommandHandler } from 'seyfert/lib/commands/handler.js';
import { assert, beforeEach, describe, test } from 'vitest';
import { CooldownManager, type CooldownProps, CooldownType } from '../src';

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
			uses: 3,
		};
		handler.values = [
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
				uses: 3,
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
				uses: 3,
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
				uses: 3,
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
				uses: 3,
			},
		]);
	});

	test('has should return false for a new cooldown', () => {
		const result = cooldownManager.has('testCommand', 'user1');
		assert.equal(result, false);
	});

	test('has should return true when cooldown is active', () => {
		for (let i = 0; i < cooldownData.uses; i++) {
			cooldownManager.use('testCommand', 'user1');
		}
		const result = cooldownManager.has('testCommand', 'user1');
		assert.equal(result, true);
	});

	test('use should set cooldown when used for the first time', () => {
		const result = cooldownManager.use('testCommand', 'user2');
		assert.equal(result, true);
	});

	test('use should return time left when cooldown is active', () => {
		for (let i = 0; i < cooldownData.uses; i++) {
			cooldownManager.use('testCommand', 'user3');
		}
		const result = cooldownManager.use('testCommand', 'user3');
		assert.ok(typeof result === 'number');
	});

	test('refill should refill the cooldown', () => {
		cooldownManager.use('testCommand', 'user1');
		const result = cooldownManager.refill('testCommand', 'user1');
		assert.equal(result, true);
		assert.equal(cooldownManager.has('testCommand', 'user1'), false);
	});

	test('drip should drip the cooldown over time', async () => {
		cooldownManager.use('testCommand', 'user1');

		// Simulate time passing
		await new Promise(resolve => setTimeout(resolve, 1000));

		const data = cooldownManager.resource.get('testCommand:user:user1');
		const props = cooldownManager.getCommandData('testCommand');
		await cooldownManager.drip('testCommand', 'user1', props![1]!, data!);
		const getter = cooldownManager.resource.get('testCommand:user:user1');
		assert.ok(getter?.remaining === 2);
	});
});
