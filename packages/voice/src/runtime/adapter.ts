import type { RuntimeUdpSocketFactory, VoiceRuntimeAdapter } from './types';
import { createRuntimeWebSocket } from './websocket';

export function createRuntimeAdapter(createUdpSocket: RuntimeUdpSocketFactory): VoiceRuntimeAdapter {
	return Object.freeze({
		createWebSocket: createRuntimeWebSocket,
		createUdpSocket,
		now: Date.now,
		random: Math.random,
	});
}

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	const candidate = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
	candidate.unref?.();
}
