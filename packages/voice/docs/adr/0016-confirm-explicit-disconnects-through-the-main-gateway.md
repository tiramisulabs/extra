# Confirm explicit disconnects through the main Gateway

`client.voice.disconnect(guildId)` will be asynchronous and idempotent. With no live connection it resolves without sending a payload. With a live connection it closes media transport, transitions the connection to a sixth coarse state named `disconnecting`, sends main-Gateway `Update Voice State` with `channel_id: null`, and resolves only after the current bot's `VOICE_STATE_UPDATE` confirms `channel_id: null`. The connection then transitions to `destroyed` and is removed from the guild registry.

ADR 0039 amends the `disconnecting` snapshot so `confirmed` may be null when disconnect cancels an initial connection before Discord has confirmed membership.

An external disconnect transitions directly to `destroyed` because the received update is already authoritative. Terminal failure and plugin teardown retain their previously defined best-effort cleanup and do not wait for acknowledgement.
