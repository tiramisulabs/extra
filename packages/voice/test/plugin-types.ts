import {
	type CommandContext,
	type ContextOf,
	createEvent,
	definePlugins,
	type ExtendOf,
	type UsingClient,
} from 'seyfert';
import {
	demuxOggOpus,
	demuxWebmOpus,
	type VoiceByteInput,
	type VoiceConnection,
	type VoiceConnectionState,
	type VoiceManager,
	type VoicePlayback,
	type VoicePlaybackSource,
	type VoicePlugin,
	type VoiceReceivedPacket,
	type VoiceReceiveStream,
	voice,
} from '../src';

function expectType<T>(_value: T): void {}

const plugin = voice();
const plugins = definePlugins(plugin);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

declare const extension: ExtendOf<typeof plugins>;
declare const context: ContextOf<typeof plugins>;
declare const usingClient: UsingClient;
declare const commandContext: CommandContext;
expectType<VoicePlugin>(plugin);
expectType<VoiceManager>(extension.voice);
expectType<VoiceManager>(context.voice);
expectType<VoiceManager>(usingClient.voice);
expectType<VoiceManager>(commandContext.voice);

declare const connection: VoiceConnection;
declare const bytes: VoiceByteInput;
declare const source: VoicePlaybackSource;
expectType<string | null>(connection.channelId);
const playback = connection.play(source);
expectType<VoicePlayback>(playback);
expectType<number>(playback.playedDurationMs);
const received = connection.receive('100000000000000001', { maxBufferedPackets: 16 });
expectType<VoiceReceiveStream>(received);
expectType<AsyncIterableIterator<VoiceReceivedPacket>>(received);
expectType<VoicePlaybackSource>(demuxOggOpus(bytes));
expectType<VoicePlaybackSource>(demuxWebmOpus(bytes));

createEvent({
	data: { name: 'voiceConnectionStateChange' },
	run(connection, next, previous) {
		expectType<VoiceConnection>(connection);
		expectType<VoiceConnectionState>(next);
		expectType<VoiceConnectionState>(previous);
	},
});

createEvent({
	data: { name: 'voicePrivacyCodeChange' },
	run(connection, next, previous) {
		expectType<VoiceConnection>(connection);
		expectType<string | null>(next);
		expectType<string | null>(previous);
	},
});
