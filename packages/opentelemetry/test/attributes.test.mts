import { assert, describe, test } from 'vitest';
import { extractInteractionAttributes, interactionSpanName, truncate } from '../src/attributes';

describe('extractInteractionAttributes', () => {
	test('pulls command fields', () => {
		const attrs = extractInteractionAttributes('command', {
			fullCommandName: 'admin ban',
			guildId: 'g1',
			channelId: 'c1',
			author: { id: 'u1' },
			interaction: { id: 'i1' },
			shardId: 2,
		});
		assert.equal(attrs['seyfert.interaction.kind'], 'command');
		assert.equal(attrs['seyfert.command'], 'admin ban');
		assert.equal(attrs['seyfert.guild_id'], 'g1');
		assert.equal(attrs['seyfert.user_id'], 'u1');
		assert.equal(attrs['seyfert.shard_id'], 2);
	});
});

describe('interactionSpanName', () => {
	test('formats command name', () => {
		assert.equal(interactionSpanName('command', { fullCommandName: 'ping' }), 'command ping');
	});

	test('truncates long customId', () => {
		const id = 'x'.repeat(200);
		const name = interactionSpanName('component', { customId: id });
		assert.equal(name, `component ${'x'.repeat(63)}…`);
	});

	test('truncate honors the full limit and does not split Unicode code points', () => {
		assert.equal(truncate('abcdef', 4), 'abc…');
		assert.equal(Array.from(truncate('😀'.repeat(100), 64)).length, 64);
		assert.ok(truncate('😀'.repeat(100), 64).endsWith('…'));
	});
});
