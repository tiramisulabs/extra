# Publish Voice Privacy Code changes separately

The Voice Plugin will declaration-merge Seyfert's `CustomEvents` with `voicePrivacyCodeChange(connection, next, previous)`, where both code values are the canonical unseparated 30-character decimal string or null. It publishes every actual observable change: establishment of the first DAVE epoch, an epoch replacement, loss of the active DAVE group after an epoch-1 reset or invalid commit or welcome, an official transition to protocol version 0, and teardown.

`VoiceConnection.voicePrivacyCode` is updated before the event is emitted, so handlers observe `next` through the connection getter. A code change does not emit `voiceConnectionStateChange` unless the lifecycle snapshot independently changed in the same commit. The DAVE Engine does not expose an EventEmitter or duplicate Seyfert's listener and disposal semantics.
