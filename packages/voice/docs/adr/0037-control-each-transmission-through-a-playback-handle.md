# Control each transmission through a playback handle

`VoiceConnection.play(source)` synchronously reserves the connection's sole Audio Transmission and returns a `VoicePlayback`. The handle exposes `readonly done: Promise<void>` and `stop(): Promise<void>`.

Returning the handle synchronously lets its owner stop a transmission even while the source is still producing its first packet. Natural source completion resolves `done` after the required five silence packets have been sent and speaking has been disabled. `stop()` requests the same clean termination, is idempotent, and resolves at that point; later source or transport failures reject `done`.

The connection will not expose a global stop operation, and the handle will not add pause, resume, queue, replacement, listener, or EventEmitter semantics. Media orchestration will retain the handle that exclusively controls the transmission it started.
