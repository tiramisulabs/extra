# Integrate through a Seyfert plugin

`@slipher/voice` will be installed through a `voice()` Seyfert plugin which exposes its primary operations on `client.voice`. The plugin owns gateway interception, required intents, voice managers, and teardown; a parallel standalone `VoiceManager` construction path will not be public. Connection and media objects returned through the plugin remain public contracts for application and plugin consumers.
