import type { VoiceConnection, VoiceManager } from '@slipher/voice';
import { voice } from '@slipher/voice';
import {
	type CommandContext,
	type ContextOf,
	createEvent,
	definePlugins,
	type ExtendOf,
	type UsingClient,
} from 'seyfert';
import {
	type GuildPlayer,
	type GuildPlayerState,
	type MediaLoadResult,
	type MediaTrack,
	type PlayerHistoryEntry,
	type PlayerManager,
	type PlayerPlugin,
	type PlayerQueueItem,
	player,
} from '../src';

function expectType<T>(_value: T): void {}

const voicePlugin = voice();
const playerPlugin = player({ voice: voicePlugin });
const plugins = definePlugins(playerPlugin);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

declare const extension: ExtendOf<typeof plugins>;
declare const context: ContextOf<typeof plugins>;
declare const usingClient: UsingClient;
declare const commandContext: CommandContext;
declare const connection: VoiceConnection;
declare const track: MediaTrack;

expectType<PlayerPlugin<typeof voicePlugin>>(playerPlugin);
expectType<typeof voicePlugin>(playerPlugin.imports[0]);
expectType<VoiceManager>(extension.voice);
expectType<PlayerManager>(extension.player);
expectType<VoiceManager>(context.voice);
expectType<PlayerManager>(context.player);
expectType<VoiceManager>(usingClient.voice);
expectType<PlayerManager>(usingClient.player);
expectType<VoiceManager>(commandContext.voice);
expectType<PlayerManager>(commandContext.player);

const guildPlayer = extension.player.create(connection);
expectType<GuildPlayer>(guildPlayer);
expectType<GuildPlayer | undefined>(extension.player.get(connection.guildId));
expectType<Promise<MediaLoadResult>>(extension.player.resolve('https://example.com/audio.ogg'));
expectType<Promise<PlayerQueueItem>>(guildPlayer.enqueue(track));
expectType<Promise<PlayerQueueItem>>(guildPlayer.enqueue(track, { position: 0 }));
expectType<Promise<readonly PlayerQueueItem[]>>(guildPlayer.enqueue([track]));
expectType<readonly PlayerHistoryEntry[]>(guildPlayer.history);
expectType<PlayerHistoryEntry | null>(guildPlayer.previous);
expectType<number | null>(guildPlayer.positionMs);
expectType<Promise<void>>(guildPlayer.clearHistory());
expectType<Promise<void>>(guildPlayer.skip(2));

createEvent({
	data: { name: 'playerStateChange' },
	run(player, next, previous) {
		expectType<GuildPlayer>(player);
		expectType<GuildPlayerState>(next);
		expectType<GuildPlayerState>(previous);
	},
});

createEvent({
	data: { name: 'playerTrackError' },
	run(player, item, error) {
		expectType<GuildPlayer>(player);
		expectType<PlayerQueueItem>(item);
		expectType<unknown>(error);
	},
});
