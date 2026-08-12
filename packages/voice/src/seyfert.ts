import type { VoiceCustomEvents } from './types';

declare module 'seyfert' {
	interface CustomEvents extends VoiceCustomEvents {}
}

export {};
