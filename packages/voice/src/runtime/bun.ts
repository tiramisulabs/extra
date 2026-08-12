import { createDaveSessionFactory } from '../dave/session';
import { createVoicePlugin, type VoicePlugin } from '../plugin';
import type { VoicePluginOptions } from '../types';
import { createRuntimeAdapter } from './adapter';
import { createBunUdpSocket } from './bun-udp';

const runtime = createRuntimeAdapter(createBunUdpSocket);

/** Creates a stateful Seyfert voice plugin for one Client or WorkerClient. */
export function voice(options: VoicePluginOptions = {}): VoicePlugin {
	return createVoicePlugin(runtime, createDaveSessionFactory(), options);
}

export * from '../public';
