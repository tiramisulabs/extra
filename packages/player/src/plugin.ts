import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { PlayerManager } from './manager';
import type { PlayerPluginOptions } from './types';

const PLAYER_REQUIREMENTS = ['plugin:@slipher/voice'] as const;

export function player(options: PlayerPluginOptions = {}): PlayerPlugin {
	const manager = PlayerManager.create(options);

	// Seyfert keeps `requires` optional in createPlugin's output even when the input provides this required tuple.
	return createPlugin({
		name: '@slipher/player',
		requires: PLAYER_REQUIREMENTS,
		manager,
		client: {
			player: () => manager,
		},
		ctx: {
			player: () => manager,
		},
		register(api) {
			api.events.on('voiceConnectionStateChange', (connection, next) => {
				manager.handleVoiceStateChange(connection, next);
			});
		},
		setup(client) {
			manager.attach(client);
		},
		teardown() {
			return manager.close();
		},
	}) as PlayerPlugin;
}

/** The stateful Seyfert plugin returned by the public player factory. */
export interface PlayerPlugin extends SeyfertPlugin<{ player: PlayerManager }, { player: PlayerManager }> {
	name: '@slipher/player';
	manager: PlayerManager;
	requires: typeof PLAYER_REQUIREMENTS;
}
