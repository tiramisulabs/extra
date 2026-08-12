# End the connection on terminal transport failure

A terminal Voice Gateway, protocol, or configuration failure ends the stable `VoiceConnection` rather than retaining a failed object for manual reuse. The Voice Plugin rejects its pending operations, removes it from the guild registry, fences late events from its resource generation, and makes a best-effort main-Gateway `Update Voice State` request with `channel_id: null` when the latest authoritative state still places the bot in a channel and the Gateway is available. Cleanup does not wait for Discord's acknowledgement and must not start a reconnect loop.

Recoverable failures and waits for fresh voice-server allocation do not use this terminal path. After termination, an explicit `connect()` creates a new `VoiceConnection` identity.
