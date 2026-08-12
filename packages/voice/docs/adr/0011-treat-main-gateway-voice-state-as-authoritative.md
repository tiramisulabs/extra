# Treat main-Gateway voice state as authoritative

A `VOICE_STATE_UPDATE` for the current bot determines its actual guild channel membership. An externally initiated move to another non-null channel keeps the stable `VoiceConnection`, adopts the new channel, and replaces its coordinated voice-session resources; an external disconnect with `channel_id: null` terminates and removes the connection without automatically rejoining. Recoverable Voice Gateway or network failures remain transport concerns and may resume or reconnect only while the authoritative main-Gateway state still places the bot in a channel.

Channel movement always waits for both a new current-bot `VOICE_STATE_UPDATE` and the corresponding `VOICE_SERVER_UPDATE`, in either arrival order. A changed server token is never paired with the previous channel's `session_id`; Discord explicitly forbids reusing the previous session during a channel change even when the endpoint is unchanged.
