import { assert, describe, test } from 'vitest';
import type { AdapterMutationTarget } from '../src/adapter-controller';
import {
	type GatewayMutationContext,
	GLOBAL_VISIBILITY_SCOPE,
	ReconciliationState,
	type ShardGeneration,
} from '../src/reconciliation-state';
import { ResourcePolicy } from '../src/resource-policy';

type ContextKind = 'dm' | 'guild' | 'none';

interface PolicyHarness {
	dmContext: GatewayMutationContext;
	generation: ShardGeneration;
	guildContext: GatewayMutationContext;
	policy: ResourcePolicy;
	state: ReconciliationState;
}

interface ScopeCase {
	context: ContextKind;
	name: string;
	target: AdapterMutationTarget;
}

function activeHarness(): PolicyHarness {
	const state = new ReconciliationState();
	state.activate();
	const generation = state.openGeneration({
		expectedGuildIds: [],
		sequence: 1,
		sessionId: 'session-a',
		shardId: 0,
	});
	state.markGuildsReady(generation);
	const position = state.observePacket(generation, 2);
	const guildContext: GatewayMutationContext = {
		event: 'GUILD_UPDATE',
		guildId: 'guild-a',
		mode: 'packet',
		position,
		shardId: 0,
	};
	const dmContext: GatewayMutationContext = {
		event: 'MESSAGE_CREATE',
		mode: 'packet',
		position,
		shardId: 0,
	};
	const policy = new ResourcePolicy(state, guildId => {
		if (guildId === 'guild-a') return 0;
		if (guildId === 'guild-b') return 1;
		return;
	});
	return { dmContext, generation, guildContext, policy, state };
}

function contextFor(harness: PolicyHarness, kind: ContextKind): GatewayMutationContext | undefined {
	if (kind === 'guild') return harness.guildContext;
	if (kind === 'dm') return harness.dmContext;
	return;
}

function relationship(to: string, id = 'entity-a'): AdapterMutationTarget {
	return { id, kind: 'relationship', operation: 'add-relationship', to };
}

function value(key: string, data?: unknown): AdapterMutationTarget {
	return { data, key, kind: 'value', operation: 'set' };
}

const GLOBAL_CASES: readonly ScopeCase[] = [
	{ context: 'none', name: 'user value', target: value('user.user-a') },
	{ context: 'none', name: 'user relationship', target: relationship('user') },
	{
		context: 'guild',
		name: 'presence value observed in a guild',
		target: value('presence.user-a', { guild_id: 'guild-a' }),
	},
	{
		context: 'none',
		name: 'DM channel value',
		target: value('channel.user-a', { guild_id: '@me' }),
	},
	{ context: 'none', name: 'DM channel relationship', target: relationship('channel.@me') },
	{ context: 'dm', name: 'DM message value', target: value('message.message-dm') },
	{ context: 'dm', name: 'DM message relationship', target: relationship('message.channel-dm') },
];

const SHARD_CASES: readonly ScopeCase[] = [
	{ context: 'none', name: 'guild value', target: value('guild.guild-a') },
	{ context: 'none', name: 'guild relationship', target: relationship('guild', 'guild-a') },
	{ context: 'none', name: 'member value', target: value('member.guild-a.user-a') },
	{ context: 'none', name: 'member relationship', target: relationship('member.guild-a') },
	{ context: 'none', name: 'ban value', target: value('ban.guild-a.user-a') },
	{ context: 'none', name: 'ban relationship', target: relationship('ban.guild-a') },
	{ context: 'none', name: 'voice state value', target: value('voice_state.guild-a.user-a') },
	{ context: 'none', name: 'voice state relationship', target: relationship('voice_state.guild-a') },
	{ context: 'none', name: 'role value', target: value('role.role-a', { guild_id: 'guild-a' }) },
	{ context: 'none', name: 'role relationship', target: relationship('role.guild-a') },
	{ context: 'none', name: 'channel value', target: value('channel.channel-a', { guild_id: 'guild-a' }) },
	{ context: 'none', name: 'channel relationship', target: relationship('channel.guild-a') },
	{ context: 'none', name: 'emoji value', target: value('emoji.emoji-a', { guild_id: 'guild-a' }) },
	{ context: 'none', name: 'emoji relationship', target: relationship('emoji.guild-a') },
	{ context: 'none', name: 'sticker value', target: value('sticker.sticker-a', { guild_id: 'guild-a' }) },
	{ context: 'none', name: 'sticker relationship', target: relationship('sticker.guild-a') },
	{ context: 'guild', name: 'empty overwrite value', target: value('overwrite.channel-a', []) },
	{ context: 'none', name: 'overwrite relationship', target: relationship('overwrite.guild-a') },
	{
		context: 'none',
		name: 'stage instance value',
		target: value('stage_instance.stage-a', { guild_id: 'guild-a' }),
	},
	{ context: 'none', name: 'stage instance relationship', target: relationship('stage_instance.guild-a') },
	{ context: 'none', name: 'presence relationship', target: relationship('presence.guild-a') },
	{ context: 'guild', name: 'guild message value', target: value('message.message-a') },
	{ context: 'guild', name: 'guild message relationship', target: relationship('message.channel-a') },
];

const UNMANAGED_CASES: readonly ScopeCase[] = [
	{ context: 'none', name: 'custom value namespace', target: value('custom.item-a') },
	{ context: 'none', name: 'custom relationship namespace', target: relationship('custom.bucket-a') },
	{ context: 'none', name: 'guild-related value without guild evidence', target: value('role.role-a') },
	{ context: 'none', name: 'channel value without guild evidence', target: value('channel.channel-a') },
	{ context: 'none', name: 'message relationship without packet ownership', target: relationship('message.channel-a') },
	{ context: 'none', name: 'guild assigned to an inactive shard', target: value('guild.guild-b') },
];

describe('ResourcePolicy ownership scopes', () => {
	test.each(GLOBAL_CASES)('$name is globally tracked', ({ context, target }) => {
		const harness = activeHarness();

		assert.deepEqual(harness.policy.resolveAdmission(target, contextFor(harness, context)), {
			kind: 'tracked',
			scope: GLOBAL_VISIBILITY_SCOPE,
		});
	});

	test.each(SHARD_CASES)('$name is tracked by its active shard generation', ({ context, target }) => {
		const harness = activeHarness();

		assert.deepEqual(harness.policy.resolveAdmission(target, contextFor(harness, context)), {
			kind: 'tracked',
			scope: harness.generation,
		});
	});

	test.each(UNMANAGED_CASES)('$name is unmanaged', ({ context, target }) => {
		const harness = activeHarness();

		assert.deepEqual(harness.policy.resolveAdmission(target, contextFor(harness, context)), { kind: 'unmanaged' });
	});
});

describe('ResourcePolicy admission fences', () => {
	test('denies managed mutations after lifecycle failure while leaving unknown namespaces unmanaged', () => {
		const harness = activeHarness();
		harness.state.fail();

		assert.deepEqual(harness.policy.resolveAdmission(value('user.user-a'), undefined), { kind: 'denied' });
		assert.deepEqual(harness.policy.resolveAdmission(value('custom.item-a'), undefined), { kind: 'unmanaged' });
	});

	test('denies an old packet context after READY replaces its shard generation', () => {
		const harness = activeHarness();
		const replacement = harness.state.openGeneration({
			expectedGuildIds: [],
			sequence: 1,
			sessionId: 'session-b',
			shardId: 0,
		});
		harness.state.markGuildsReady(replacement);
		const currentContext: GatewayMutationContext = {
			...harness.guildContext,
			position: harness.state.observePacket(replacement, 2),
		};
		const target = value('role.role-a', { guild_id: 'guild-a' });

		assert.deepEqual(harness.policy.resolveAdmission(target, harness.guildContext), { kind: 'denied' });
		assert.deepEqual(harness.policy.resolveAdmission(target, currentContext), {
			kind: 'tracked',
			scope: replacement,
		});
	});
});
