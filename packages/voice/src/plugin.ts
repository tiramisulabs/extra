import { createPlugin, PluginOrder, type SeyfertPlugin } from 'seyfert';
import type { DaveSessionFactoryResource } from './dave/types';
import { VoiceManager } from './manager';
import type { VoiceRuntimeAdapter } from './runtime/types';
import type { VoicePluginOptions } from './types';
import { createVoiceGatewayTransportFactory } from './voice-gateway/session';

/** @internal */
export function createVoicePlugin(
	runtime: VoiceRuntimeAdapter,
	daveFactory: DaveSessionFactoryResource,
	options: VoicePluginOptions = {},
): VoicePlugin {
	const manager = VoiceManager.create(options, createVoiceGatewayTransportFactory(runtime, daveFactory));

	return createPlugin({
		name: '@slipher/voice',
		client: {
			voice: () => manager,
		},
		ctx: {
			voice: () => manager,
		},
		register(api) {
			api.gateway.addIntents('GuildVoiceStates');
			api.gateway.onDispatch(
				(packet, next, metadata) => {
					// Observe coordination before later transformations without consuming the Gateway dispatch.
					manager.enqueueGatewayDispatch(packet, metadata.shardId);
					return next(packet);
				},
				{ order: PluginOrder.Before },
			);
		},
		setup(client) {
			manager.attach(client);
		},
		teardown() {
			return closeVoicePluginResources(manager, daveFactory);
		},
	});
}

async function closeVoicePluginResources(
	manager: VoiceManager,
	daveFactory: DaveSessionFactoryResource,
): Promise<void> {
	const errors: unknown[] = [];
	try {
		await manager.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		await daveFactory.close();
	} catch (error) {
		errors.push(error);
	}
	if (errors.length) throw new AggregateError(errors, 'Failed to close the voice plugin.');
}

/** The stateful Seyfert plugin returned by the public voice factory. */
export interface VoicePlugin extends SeyfertPlugin<{ voice: VoiceManager }, { voice: VoiceManager }> {
	name: '@slipher/voice';
}
