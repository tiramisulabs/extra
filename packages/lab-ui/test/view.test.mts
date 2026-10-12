import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveView } from '../src/app/state';
import type { LabSnapshot } from '../src/bridge';
import { FixtureClient } from '../src/dev/FixtureClient';

test('a running session shows the first viewable actor in its own channel until the user picks', async () => {
	const snapshot = await new FixtureClient().connect();
	assert.deepEqual(resolveView(snapshot, {}), { actor: 'alice', guildId: 'guild', channel: 'general' });
	assert.deepEqual(resolveView(snapshot, { actor: 'bob', channel: 'staff' }), {
		actor: 'bob',
		guildId: 'guild',
		channel: 'staff',
	});
	// A pick the session no longer has falls back instead of leaving the view empty.
	assert.deepEqual(resolveView(snapshot, { actor: 'gone', channel: 'deleted' }), {
		actor: 'alice',
		guildId: 'guild',
		channel: 'general',
	});
});

test('the guild follows the open channel, and no session shows no view', async () => {
	const snapshot = await new FixtureClient().connect();
	const session = snapshot.session;
	assert.ok(session);
	const withSecondGuild: LabSnapshot = {
		...snapshot,
		session: {
			...session,
			guilds: [
				...session.guilds,
				{
					id: 'other',
					name: 'Other',
					roles: [],
					members: [],
					channels: [{ id: 'lobby', name: 'lobby', type: 0, visibleTo: ['alice'] }],
				},
			],
		},
	};
	assert.deepEqual(resolveView(withSecondGuild, { channel: 'lobby' }), {
		actor: 'alice',
		guildId: 'other',
		channel: 'lobby',
	});
	assert.deepEqual(resolveView({ ...snapshot, session: undefined }, { actor: 'bob', channel: 'staff' }), {
		actor: '',
		guildId: '',
		channel: '',
	});
});
