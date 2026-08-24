# @slipher/voice

Discord voice connections for Seyfert, including a package-owned TypeScript implementation of the DAVE MLS profile.

**[Read the complete Voice guide on seyfert.dev](https://seyfert.dev/docs/plugins/official/voice).**

## Install

```sh
pnpm add @slipher/voice seyfert
```

Requires Node.js 22.13 or newer and Seyfert v5. Bun and Deno are supported through their Node.js compatibility layers; Deno needs network permission.

## Quick start

```ts
import { voice } from '@slipher/voice';
import { Client, definePlugins } from 'seyfert';

const plugins = definePlugins(voice());

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });

const connection = await client.voice.connect({ guildId, channelId });
```

The package sends and receives complete Opus packets. Media resolution, transcoding, volume, mixing, and playback queues belong in an orchestration layer such as `@slipher/player`.
