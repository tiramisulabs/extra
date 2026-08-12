# Require explicit channel movement

`client.voice.connect({ guildId, channelId })` is idempotent when the existing connection already targets that channel. If the guild's stable connection targets a different channel, the call fails unless it includes `move: true`; with that authorization, the existing connection serializes a move to the requested channel without changing object identity. No separate `move()` or `rejoin()` alias will duplicate this behavior.
