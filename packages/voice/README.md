# @slipher/voice

Discord voice connections for Seyfert, including a package-owned TypeScript implementation of the DAVE MLS profile.

The package establishes, maintains, moves, recovers, verifies, and disconnects voice sessions, and sends and receives already encoded Opus audio. Volume control, mixing, transcoding, and media policy remain separate orchestration plugins.

## Install

```sh
pnpm add @slipher/voice seyfert
```

Node.js 22.13 or newer, Bun, and Deno are supported through package export conditions. Deno needs network permission for Discord's Gateway, Voice Gateway, and UDP transport:

```sh
deno run --allow-net bot.ts
```

## Configure Seyfert

```ts
import { Client, definePlugins } from 'seyfert';
import { voice } from '@slipher/voice';

const plugins = definePlugins(
	voice({
		operationTimeoutMs: 30_000,
	}),
);

declare module 'seyfert' {
	interface SeyfertRegistry {
		plugins: typeof plugins;
	}
}

export const client = new Client({ plugins });
```

The plugin contributes the same manager as `client.voice` and `ctx.voice`, adds the `GuildVoiceStates` intent, and observes the raw voice coordination events before normal dispatch handling.

## Connect and move

```ts
const connection = await client.voice.connect({
	guildId,
	channelId,
	selfDeaf: true,
});

await client.voice.connect({
	guildId,
	channelId: anotherChannelId,
	move: true,
});

await connection.setSelfState({ selfMute: true });
await client.voice.disconnect(guildId);
```

There is at most one live connection per guild. Calling `connect()` for another channel requires `move: true`; otherwise it rejects with `VOICE_MOVE_REQUIRED`. Equivalent in-flight requests share one promise, while conflicting operations reject instead of forming an implicit queue.

`connection.channelId` is the last channel Discord confirmed for that connection, or `null` before the first confirmation. During a move it remains the previous channel until Discord confirms the destination, so it can be compared with the invoking member's voice channel without treating an in-flight target as already joined.

`client.voice.connections` is a live `ReadonlyMap<string, VoiceConnection>`. Each connection exposes an immutable `state` snapshot with one of these statuses:

- `connecting`
- `ready`
- `moving`
- `disconnecting`
- `recovering`
- `destroyed`

## Play Opus audio

`VoiceConnection.play()` accepts an `AsyncIterable<Uint8Array>` where each value is one complete Opus packet. Ogg Opus and WebM Opus byte streams can be converted to that packet source with the built-in demuxers:

```ts
import { createReadStream } from 'node:fs';
import { demuxOggOpus } from '@slipher/voice';

const connection = await client.voice.connect({
	guildId,
	channelId,
});

const playback = connection.play(
	demuxOggOpus(createReadStream('./audio.ogg')),
);

await playback.done;
```

For bytes already in memory, pass the `Uint8Array` directly. Use `demuxWebmOpus()` for a WebM Opus container. The package does not open paths or run FFmpeg itself.

`play()` reserves the connection's single transmission synchronously. A second concurrent call rejects with `VOICE_OPERATION_CONFLICT`. The returned `VoicePlayback` exposes `done` and idempotent `stop()`:

```ts
const playback = connection.play(opusPackets);

// Later, if the owner wants to end this transmission:
await playback.stop();
```

`playback.playedDurationMs` reports the duration of source audio successfully sent to the voice transport. It is calculated from the Opus packet sample counts, remains stable during source underflow, and excludes the five closing silence frames.

The connection owns Opus timing, RTP sequence and timestamp progression, speaking signaling, five-frame silence termination, DAVE frame encryption, and Discord transport encryption. It pauses speaking cleanly during source underflow and resumes the same playback when another packet arrives.

## Receive Opus audio

Join with `selfDeaf: false`, then subscribe to one participant by user ID. Each yielded value contains one complete, authenticated Opus packet and its RTP metadata:

```ts
const connection = await client.voice.connect({
	guildId,
	channelId,
	selfDeaf: false,
});

const stream = connection.receive(userId);

try {
	for await (const packet of stream) {
		consumeOpus(packet.opus, {
			sequence: packet.sequence,
			timestamp: packet.timestamp,
			ssrc: packet.ssrc,
		});
	}
} finally {
	stream.close();
}
```

The stream keeps at most 32 unread packets by default and drops the oldest packet when the consumer falls behind live audio. Set a different bound with `connection.receive(userId, { maxBufferedPackets })`. RTP sequence and timestamp values let downstream code detect loss and implement its own jitter policy.

Subscriptions remain attached to the stable connection during transport recovery, but yield media only while that connection is ready. Destroying the connection closes all of its streams. The core returns encoded Opus; decoding to PCM, recording containers, transcription, jitter buffering, and mixing belong in consumers or plugins.

## DAVE verification

```ts
const privacyCode = connection.voicePrivacyCode;
const participantCode = await connection.getVerificationCode(userId);
```

`voicePrivacyCode` is `null` until a nonzero DAVE MLS epoch is established. Otherwise it is the canonical 30-digit epoch code. `getVerificationCode()` asynchronously derives the canonical 45-digit pairwise code for another active participant.

These values support out-of-band comparison; the package does not make a trust decision for the application. Changes to the epoch code are also published through Seyfert's typed `voicePrivacyCodeChange` custom event.

## Current boundary

The package currently owns:

- main-Gateway voice-state coordination for `Client` and compatible `WorkerClient` instances;
- Voice Gateway v8, heartbeats, resume, IP discovery, UDP lifecycle, and documented close-code recovery;
- AES-256-GCM and XChaCha20-Poly1305 transport mode negotiation;
- DAVE v1 control messages, MLS ciphersuite 2, TreeKEM, commits, Welcome processing, recovery, and verification;
- one pull-based Opus transmission per connection, including RTP pacing, speaking, silence termination, DAVE Secure Frames, and transport encryption;
- bounded per-participant Opus receive streams, including SSRC mapping, RTP transport decryption, DAVE Secure Frames decryption, replay rejection, and epoch-transition retention;
- streaming Ogg Opus and WebM Opus demultiplexing from memory or caller-owned byte sources;
- Node, Bun, and Deno runtime adapters.

It intentionally excludes video, Go Live, filesystem access, FFmpeg, PCM conversion, Opus encoding, playback queues, jitter buffering, recording containers, volume, and mixing.
