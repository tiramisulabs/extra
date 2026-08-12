# Publish state through Seyfert events

`VoiceConnection` will expose its current immutable `ConnectionState` through a readonly `state` property. The Voice Plugin will declaration-merge Seyfert's `CustomEvents` with a typed `voiceConnectionStateChange(connection, next, previous)` event and publish each committed transition through `client.events.emit()`. Applications consume it with Seyfert's `createEvent()` contract, while plugins consume it through `api.events.on()`.

Transport progression will not await observational event delivery. `VoiceConnection` will not expose `onStateChange()`, inherit from an event emitter, or implement separate listener registration, disposal, scheduling, and failure semantics. Those concerns remain owned by Seyfert's event system; later voice capabilities will extend that system when they require public events.

DAVE verification later adds a separate typed `voicePrivacyCodeChange(connection, next, previous)` custom event. A privacy-code update does not produce a lifecycle state-change event merely to signal unrelated cryptographic observation.
