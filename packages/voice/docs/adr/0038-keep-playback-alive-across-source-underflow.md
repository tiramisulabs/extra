# Keep playback alive across source underflow

The transmission scheduler keeps one Opus packet of lookahead. Before the source produces its first packet, Voice Playback waits without enabling speaking. Once transmission has started, a packet that is not available by its deadline begins Discord's clean silence termination and disables speaking after five silence packets, but does not complete or fail the playback.

An underflow has no implicit timeout. If the pending source later produces another packet, the scheduler re-enables speaking and resumes transmission using the RTP clock progression required for the elapsed media timeline. Only iterator completion represents normal end-of-source.

Explicit stop fences the pending iterator generation immediately, invokes `return()` as best-effort source cleanup, and completes after protocol silence termination without waiting indefinitely for an uncooperative iterator. A late `next()` result never restarts the stopped transmission.
