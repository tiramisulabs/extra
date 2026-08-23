import type { PlayerCustomEvents } from './types';

declare module 'seyfert' {
	interface CustomEvents extends PlayerCustomEvents {}
}

export {};
