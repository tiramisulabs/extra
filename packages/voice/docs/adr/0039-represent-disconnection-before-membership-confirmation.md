# Represent disconnection before membership confirmation

An explicit `disconnect()` may supersede an initial `connect()` after its Gateway request was sent but before Discord emits the first current-bot `VOICE_STATE_UPDATE`. During that interval there is no authoritative channel membership to place in a `disconnecting` snapshot. Therefore `disconnecting.confirmed` is `VoiceConfirmedState | null`; the package never copies the canceled connection target into the confirmed field.

The disconnect operation still sends `channel_id: null`, waits for Discord's authoritative null voice-state confirmation, and remains bounded by the configured operation deadline. A later non-null voice-state update is processed while the leave remains pending and is followed by the same leave intent rather than reviving the canceled connection.
