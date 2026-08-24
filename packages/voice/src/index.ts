import { createDaveSessionFactory } from './dave/session';
import { createVoicePlugin, type VoicePlugin } from './plugin';
import { createRuntimeAdapter } from './runtime/adapter';
import { createNodeUdpSocket } from './runtime/node-udp';
import type { VoicePluginOptions } from './types';

const runtime = createRuntimeAdapter(createNodeUdpSocket);

/** Creates a stateful Seyfert voice plugin for one Client or WorkerClient. */
export function voice(options: VoicePluginOptions = {}): VoicePlugin {
	return createVoicePlugin(runtime, createDaveSessionFactory(), options);
}

export * from './public';
