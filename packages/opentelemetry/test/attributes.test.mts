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

	test('ignores a throwing declared name and falls back to the declared custom id', () => {
		const context = {
			customId: 'btn-1',
			command: {
				customId: 'vote',
				spanName: () => {
					throw new Error('boom');
				},
			},
		};
		assert.equal(interactionSpanName('component', context), 'component vote');
	});

	test('uses the custom id declared by the handler, which matches by equality', () => {
		const context = { customId: 'vote', command: { customId: 'vote' } };
		assert.equal(interactionSpanName('component', context), 'component vote');
	});

	test('uses the handler class name when it matches by regexp', () => {
		class VoteButton {
			customId = /^vote:\d+$/;
		}
		const context = { customId: 'vote:849201', command: new VoteButton() };
		assert.equal(interactionSpanName('component', context), 'component VoteButton');
	});

	test('uses the handler class name when it matches by filter only', () => {
		class ConfirmModal {
			filter() {
				return true;
			}
		}
		const context = { customId: 'confirm:849201', command: new ConfirmModal() };
		assert.equal(interactionSpanName('modal', context), 'modal ConfirmModal');
	});

	// The runtime custom id carries per-interaction state; it must never reach a span name.
	test('never falls back to the runtime custom id', () => {
		assert.equal(interactionSpanName('component', { customId: 'vote:849201:yes' }), 'component unknown');
	});
});
