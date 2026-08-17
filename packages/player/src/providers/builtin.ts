import { createMediaBackend } from '../media/backend';
import type { MediaProvider } from '../types';
import { createByteMediaProvider, createFileMediaProvider } from './local';
import { createRadioMediaProvider, createUrlMediaProvider } from './remote';

export interface BuiltinMediaProviderOptions {
	readonly ffmpegPath?: string;
}

export interface BuiltinMediaProviderBundle {
	readonly providers: readonly MediaProvider[];
	close(): Promise<void>;
}

export function createBuiltinMediaProviderBundle(
	options: BuiltinMediaProviderOptions = {},
): BuiltinMediaProviderBundle {
	const backend = createMediaBackend(options);
	return Object.freeze({
		providers: Object.freeze([
			createByteMediaProvider(backend),
			createFileMediaProvider(backend),
			createRadioMediaProvider(backend),
			createUrlMediaProvider(backend),
		]),
		close: () => backend.close(),
	});
}
