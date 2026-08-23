# Minimal Seyfert music bot

This example joins the invoking member's voice channel and queues a YouTube video with `@slipher/voice` and
`@slipher/player`.

## Run

1. Copy `.env.example` to `.env` and add the Discord bot token.
2. From the repository root, install the monorepo dependencies and build the example with its local package dependencies:

   ```sh
   pnpm install
   pnpm turbo build --filter=seyfert-music-bot
   ```

3. Start the bot from the repository root:

   ```sh
   pnpm --filter seyfert-music-bot start
   ```

4. Join a voice channel and use either command form with a YouTube video URL:

   ```text
   /play source:<url>
   !play -source <url>
   ```

The example consumes `@slipher/voice` and `@slipher/player` directly from this workspace. The bot uploads its
application commands after connecting. Its provider runs the bundled `yt-dlp` binary, resolves YouTube's WebM Opus
audio, and prepares the first Opus packet before joining the voice channel. It then passes the stream through the WebM
demuxer exported by `@slipher/voice`.

No PCM decoder, Opus encoder, `@discordjs/opus`, or FFmpeg process is involved. YouTube live streams, playlists, search
queries, Spotify, and other vendors are intentionally outside this minimal example.
