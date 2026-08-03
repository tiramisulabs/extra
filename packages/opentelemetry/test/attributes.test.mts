import { assert, describe, test } from 'vitest';
import { extractInteractionAttributes, interactionSpanName } from '../src/attributes';

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

	test('prefers a name declared by the handler', () => {
		const context = { customId: 'open-settings:a1b2c3', command: { spanName: 'open-settings' } };
		assert.equal(interactionSpanName('component', context), 'component open-settings');
	});

	test('resolves a declared name function against the context', () => {
		const context = {
			customId: 'menu:profile',
			command: {
				spanName: (ctx: unknown) => `menu:${String((ctx as { customId: string }).customId).split(':')[1]}`,
			},
		};
		assert.equal(interactionSpanName('component', context), 'component menu:profile');
	});

	test('ignores a throwing declared name', () => {
		const context = {
			customId: 'btn-1',
			command: {
				spanName: () => {
					throw new Error('boom');
				},
			},
		};
		assert.equal(interactionSpanName('component', context), 'component btn-1');
	});

	test('falls back to the custom id', () => {
		assert.equal(interactionSpanName('component', { customId: 'btn-1' }), 'component btn-1');
	});
});
