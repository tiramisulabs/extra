# Demultiplex Opus containers without owning I/O

The package turns Ogg Opus and WebM Opus container bytes into a Playback Source without transcoding. Container input may be a complete in-memory `Uint8Array` or an `AsyncIterable<Uint8Array>` whose chunks come from disk or another byte producer. The demuxer restores complete Opus packet boundaries independently of input chunk boundaries.

The core does not accept path strings, open files, request filesystem permissions, or spawn processes. Callers own disk access and pass its byte stream into the same portable demuxer used for in-memory data.

MP3, WAV, AAC, FLAC, non-Opus container tracks, and incompatible Opus tracks require decoding or transcoding and remain outside the core package. A media plugin may use FFmpeg or another codec stack and expose the result through the same Playback Source contract.
