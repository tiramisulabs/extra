# Limit the package to bot audio

`@slipher/voice` establishes and protects voice connections and sends or receives Discord bot audio only. Its DAVE Engine implements the Opus frame transforms required for bot voice, while video and Go Live transport, soundshare, video sink negotiation, and the VP8, VP9, H264, H265, and AV1 frame transforms remain outside the package boundary.

This is not a staged promise to add video. Discord bots do not have a supported video product contract, so implementing the whitepaper's client video paths would add untestable cryptographic and codec behavior without a bot consumer. The MLS group, epoch, and sender-ratchet rules remain codec-independent where the protocol naturally makes them so, but the public API will not introduce speculative media-type abstractions or video extension hooks.
