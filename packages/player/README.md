# @slipher/player

Media sources, playback queues, and player controls for [`@slipher/voice`](../voice).

The package keeps Discord's voice protocol inside `@slipher/voice`. It resolves media, opens local or remote audio,
transcodes when needed, and gives each guild one queue-driven player.

## Install

```sh
pnpm add @slipher/player @slipher/voice seyfert
```

[FFmpeg](https://ffmpeg.org/) must be available for media that is not already compatible Ogg Opus or WebM Opus.
Configure another executable path with `ffmpegPath`. Direct Opus playback does not start FFmpeg.

Node.js 22.13 or newer is the primary runtime. Bun and Deno use their Node compatibility layers. For Deno, grant
`--allow-read` for local files, `--allow-net` for URLs and radio, and `--allow-run` when FFmpeg is needed.

## Configure Seyfert

Register Voice before Player. Player declares Voice as a required Seyfert plugin, while the registry order ensures
Player is torn down before Voice.

```ts
import { Client, definePlugins } from 'seyfert';
import { player } from '@slipher/player';
import { voice } from '@slipher/voice';

const plugins = definePlugins(
	voice(),
	player({
		ffmpegPath: 'ffmpeg',
		historyLimit: 100,
	}),
);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

The plugin exposes the same `PlayerManager` as `client.player` and `ctx.player`. The registered Voice plugin also exposes
`client.voice` and `ctx.voice`.

## Play local media

Connect through `@slipher/voice`, create the guild player from that connection, then enqueue a track:

```ts
import { file } from '@slipher/player';

const connection = await client.voice.connect({
	guildId,
	channelId,
});

const guildPlayer = client.player.create(connection);
await guildPlayer.enqueue(file('./music/song.mp3'));
```

`create(connection)` is idempotent for the same guild and connection. If Discord destroys the voice connection and the
bot reconnects, pass the new connection to `create()`; the existing player and its waiting queue are rebound to it.
Two different live connections for the same guild are rejected.

Only `.opus` is inferred as Ogg Opus because `.ogg` and `.webm` can contain other codecs. Give known compatible
containers an explicit format hint to use the direct demuxers from `@slipher/voice`; unknown formats are converted to
48 kHz, stereo Opus by FFmpeg:

```ts
await guildPlayer.enqueue(file('./music/song.ogg', { format: 'ogg-opus' }));
await guildPlayer.enqueue(file('./music/song.webm', { format: 'webm-opus' }));
```

For media already in memory:

```ts
import { bytes } from '@slipher/player';

await guildPlayer.enqueue(bytes(audioBytes, { title: 'Generated audio' }));
```

Byte tracks are process-local. They cannot be serialized or reopened by another process.

## Play URLs and radio

Use `url()` for finite remote media and `radio()` for a live source:

```ts
import { radio, url } from '@slipher/player';

await guildPlayer.enqueue(url('https://cdn.example.com/song.ogg'));
await guildPlayer.enqueue(radio('https://radio.example.com/live', { title: 'Example FM' }));
```

`client.player.resolve(query)` can also resolve supported HTTP URLs and local paths:

```ts
const result = await client.player.resolve(input);

if (result.kind === 'track') {
	await guildPlayer.enqueue(result.track);
}
```

Resolution returns `track`, `playlist`, `search`, or `empty`. The built-in v1 providers cover in-memory media, local
files, HTTP media, and radio. A custom provider can add another source without changing the queue or voice transport.
Provider names must be unique and cannot replace a built-in provider. Errors thrown by custom `resolve()` or `open()`
implementations propagate unchanged, so a provider can preserve its own typed failure contract.

## Queue and playback controls

```ts
await guildPlayer.enqueue([firstTrack, secondTrack]);
await guildPlayer.enqueue(playNextTrack, { position: 0 });
await guildPlayer.pause();
await guildPlayer.resume();
await guildPlayer.skip(2);
await guildPlayer.seek(30_000);
await guildPlayer.setRepeat('queue');
await guildPlayer.stop();
```

`position` is a zero-based index in the pending queue, so position `0` atomically inserts a track next without exposing an intermediate append-and-move state. A skip count includes the current item; bypassed pending items never enter history because they were never current.

`guildPlayer.history` is an oldest-to-newest list of immutable `{ item, reason }` snapshots. It records every item that
became current, including `finished`, `skipped`, `stopped`, `load-failed`, `connection-unavailable`, and `destroyed`
outcomes. The default keeps the latest 100 entries; set `historyLimit: 0` to disable it, or call
`await guildPlayer.clearHistory()` to clear it. History snapshots intentionally omit queue metadata and the private
byte payload of `bytes()` tracks so completed items do not retain arbitrary application state or media buffers.

`guildPlayer.previous` is the most recent history entry. For finite media, `guildPlayer.positionMs` combines the latest seek offset with the duration of Opus audio actually sent to Discord. It is `null` for live media or when no item is current.

The public state is `idle`, `waiting`, `loading`, `playing`, `paused`, or `destroyed`. When voice becomes unavailable,
the current item ends with `connection-unavailable` and queued items wait for a playable connection. Muting the bot,
Stage suppression, moving, recovery, or disconnecting all make voice unavailable.

Pause gates finite media without bypassing the pacing owned by `@slipher/voice`. A live source closes on pause and
reopens at its live edge on resume. Seek is available only for tracks whose finite timeline is marked seekable.

Player lifecycle is also observable through typed Seyfert events:

- `playerStateChange`
- `playerTrackStart`
- `playerTrackEnd`
- `playerTrackError`
- `playerQueueEnd`

## Boundary

`@slipher/player` owns source resolution, media resource cleanup, optional FFmpeg transcoding, per-guild queues,
repeat, pause, resume, seek, skip, and voice-availability coordination. `@slipher/voice` remains responsible for Opus
pacing, speaking signaling, RTP, DAVE, encryption, and the Discord voice connection.

Spotify, YouTube extraction, vendor authentication, recommendation systems, volume filters, and PCM mixing are not
built into this first package. They can be implemented by additional providers or higher-level plugins.
