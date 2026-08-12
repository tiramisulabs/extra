# Expose five coarse connection states

This decision's state count is amended by ADR 0016, which adds `disconnecting` for an explicit leave awaiting Discord confirmation.

`VoiceConnection.state` will be an immutable discriminated union with five public statuses: `connecting` for initial establishment, `ready` when the Voice WebSocket, UDP transport, negotiated transport encryption, and active DAVE media context are operational, `moving` for a locally authorized or externally initiated channel change, `recovering` for a previously operational connection restoring transport or awaiting fresh server allocation, and `destroyed` for an irreversible terminal state. Initial MLS group construction may remain pending while Discord keeps protocol version 0 as the active media context; that pending group does not make the established transport unready.

Public lifecycle states will not mirror every Voice Gateway, UDP, or DAVE handshake step. Connecting and moving snapshots distinguish the channel last confirmed by Discord from the requested target channel, so the API never reports intent as authoritative membership. The later observation contract must publish whole state snapshots rather than exposing partially mutated state.
