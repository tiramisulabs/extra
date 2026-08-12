import type { VoicePlugin } from '@slipher/voice';
import { createPlugin, type SeyfertPlugin } from 'seyfert';
import { PlayerManager } from './manager';
import type { PlayerPluginOptions } from './types';

export function player<const TVoice extends VoicePlugin>(options: PlayerPluginOptions<TVoice>): PlayerPlugin<TVoice> {
	if (!options || typeof options !== 'object' || !options.voice || options.voice.name !== '@slipher/voice') {
		throw new TypeError('The player plugin requires the @slipher/voice plugin instance.');
	}
	const manager = PlayerManager.create(options);
	const imports: readonly [TVoice] = [options.voice];

	// Seyfert keeps `imports` optional in its output type even when the input provides this required tuple.
	return createPlugin({
		name: '@slipher/player',
		imports,
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
	}) as PlayerPlugin<TVoice>;
}

/** The stateful Seyfert plugin returned by the public player factory. */
export interface PlayerPlugin<TVoice extends VoicePlugin = VoicePlugin>
	extends SeyfertPlugin<{ player: PlayerManager }, { player: PlayerManager }, readonly [TVoice]> {
	name: '@slipher/player';
	manager: PlayerManager;
	imports: readonly [TVoice];
}
