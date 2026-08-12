# Accept only encoded Opus playback sources

The core package accepts complete, already encoded Opus packets and transmits at most one Playback Source per Voice Connection. It owns frame pacing, RTP sequence and timestamp progression, speaking signaling, Discord's required five-frame silence termination, DAVE frame transformation, and transport encryption.

The package will not expose unrestricted packet dispatch. Allowing callers to push arbitrary packets and timing would move protocol correctness outside the component that promises Discord compatibility. PCM conversion, Opus encoding, FFmpeg integration, queues, volume control, and mixing instead belong to Media Orchestration implemented by applications or plugins.

This encoded boundary avoids selecting native or runtime-specific codec dependencies for the Node, Bun, and Deno core. A mixer or queue plugin will produce one encoded source for the same transmission contract rather than bypassing the connection's protocol machinery.
