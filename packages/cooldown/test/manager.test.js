const { strict: assert } = require("node:assert/strict");
const { test, describe, beforeEach } = require('node:test');
const { Client, Cache, MemoryAdapter, Logger } = require('seyfert');
const { CommandHandler } = require('seyfert/lib/commands/handler.js');
const { CooldownManager } = require('../lib/manager.js');
const { CooldownType } = require('../lib/resource.js');


describe('CooldownManager', async () => {
  let client;
  let cooldownManager;

  beforeEach(() => {
    client = new Client();

    const handler = new CommandHandler(new Logger({ active: true }), client);
    handler.values = [
      // @ts-expect-error
      {
        name: 'testCommand',
        cooldown: {
          type: CooldownType.User,
          interval: 1000,
          refill: 3,
          tokens: 1
        }
      }
    ]

    client.commands = handler;


    client.cache = new Cache(0, new MemoryAdapter(), {}, client);
    cooldownManager = new CooldownManager(client);
    client.cache.cooldown = cooldownManager.resource;
  });

  await test('getData should return cooldown data for a command', () => {
    const data = cooldownManager.getData('testCommand');
    assert.deepEqual(data, {
      type: CooldownType.User,
      interval: 1000,
      refill: 3,
      tokens: 1
    });
  });

  await test('getData should return undefined for non-existent command', () => {
    const data = cooldownManager.getData('nonExistentCommand');
    assert.equal(data, undefined);
  });

  await test('has should return false for a new cooldown', () => {
    const result = cooldownManager.has('testCommand', 'user1');
    assert.equal(result, false);
  });

  await test('has should return true when cooldown is active', () => {
    cooldownManager.use('testCommand', 'user1', 1000);
    const result = cooldownManager.has('testCommand', 'user1');
    assert.equal(result, true);
  });

  await test('use should set cooldown when used for the first time', () => {
    const result = cooldownManager.use('testCommand', 'user1');
    assert.equal(result, true);
  });

  await test('use should return true when cooldown is active', () => {
    cooldownManager.use('testCommand', 'user1');
    const result = cooldownManager.use('testCommand', 'user1');
    assert.equal(result, true);
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
    await new Promise(resolve => setTimeout(resolve, 1500)); // Half the interval

    const data = cooldownManager.resource.get('testCommand:user:user1');
    const props = cooldownManager.getData('testCommand');
    const result = cooldownManager.drip('testCommand', 'user1', props, data);
    assert.ok(result.remaining === 3);
  });
});

