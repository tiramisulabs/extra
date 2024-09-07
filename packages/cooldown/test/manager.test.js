const { strict: assert } = require("node:assert/strict");
const { test, describe, beforeEach } = require('node:test');
const { Client, Cache, MemoryAdapter, Logger } = require('seyfert');
const { CommandHandler } = require('seyfert/lib/commands/handler.js');
const { CooldownManager } = require('../lib/manager.js');
const { CooldownType } = require('../lib/resource.js');


describe('CooldownManager', async () => {
  let client;
  let cooldownManager;
  let cooldownData;

  beforeEach(() => {
    client = new Client({ getRC: () => ({ debug: true }) });

    const handler = new CommandHandler(new Logger({ active: true }), client);
    cooldownData = {
      type: CooldownType.User,
      interval: 10000,
      uses: 3
    }
    handler.values = [
      // @ts-expect-error
      {
        name: 'testCommand',
        cooldown: cooldownData
      }
    ]

    client.commands = handler;


    client.cache = new Cache(0, new MemoryAdapter(), {}, client);
    cooldownManager = new CooldownManager(client);
  });

  await test('Data should return cooldown data for a command', () => {
    const data = cooldownManager.getCommandData('testCommand');
    assert.deepEqual(data, {
      type: CooldownType.User,
      interval: 10000,
      uses: 3
    });
  });

  await test('Data should return undefined for non-existent command', () => {
    const data = cooldownManager.getCommandData('nonExistentCommand');
    assert.equal(data, undefined);
  });

  await test('has should return false for a new cooldown', () => {
    const result = cooldownManager.has('testCommand', 'user1');
    assert.equal(result, false);
  });

  await test('has should return true when cooldown is active', () => {
    for (let i = 0; i < cooldownData.uses; i++) {
      cooldownManager.use('testCommand', 'user1');
    }
    const result = cooldownManager.has('testCommand', 'user1');
    assert.equal(result, true);
  });

  await test('use should set cooldown when used for the first time', () => {
    const result = cooldownManager.use('testCommand', 'user2');
    assert.equal(result, true);
  });

  await test('use should return time left when cooldown is active', () => {
    for (let i = 0; i < cooldownData.uses; i++) {
      cooldownManager.use('testCommand', 'user3');
    }
    const result = cooldownManager.use('testCommand', 'user3');
    assert.ok(typeof result === 'number');
  });

  await test('refill should refill the cooldown', () => {
    cooldownManager.use('testCommand', 'user1');
    const result = cooldownManager.refill('testCommand', 'user1');
    assert.equal(result, true);
    assert.equal(cooldownManager.has('testCommand', 'user1'), false);
  });

  await test('drip should drip the cooldown over time', async () => {
    cooldownManager.use('testCommand', 'user1');

    // Simulate time passing
    await new Promise(resolve => setTimeout(resolve, 10000));

    const data = cooldownManager.resource.get('testCommand:user:user1');
    const props = cooldownManager.getCommandData('testCommand');
    await cooldownManager.drip('testCommand', 'user1', props, data);
    const getter = cooldownManager.resource.get('testCommand:user:user1');
    assert.ok(getter.remaining === 2);
  });
});

