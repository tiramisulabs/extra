# @slipher/player

Media sources, playback queues, and player controls on top of `@slipher/voice`.

**[Read the complete Player guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/player).**

## Install

```sh
pnpm add @slipher/player @slipher/voice seyfert
```

Requires Node.js 22.13 or newer and Seyfert v5. FFmpeg must be available for media that is not already compatible Ogg Opus or WebM Opus.

## Quick start

```ts
import { file, player } from '@slipher/player';
import { voice } from '@slipher/voice';
import { Client, definePlugins } from 'seyfert';

const plugins = definePlugins(voice(), player({ ffmpegPath: 'ffmpeg' }));

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });

const connection = await client.voice.connect({ guildId, channelId });
const guildPlayer = client.player.create(connection);
await guildPlayer.enqueue(file('./music/song.mp3'));
```

Register Voice before Player. Direct Opus playback does not start FFmpeg; pass an explicit format hint for compatible `.ogg` or `.webm` sources.
