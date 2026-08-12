# Resolve connect when media is operational

`client.voice.connect(...)` will return a `Promise<VoiceConnection>` that resolves only when the requested channel is operational for media, rather than when the main-Gateway payload is sent. Equivalent concurrent calls share the in-flight operation, movement resolves after the stable connection reaches the new channel, and conflicts, timeouts, or terminal handshake failures reject through the returned promise.
