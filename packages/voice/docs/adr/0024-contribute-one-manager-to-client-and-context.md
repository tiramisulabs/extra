# Contribute one manager to client and context

The `voice()` plugin will contribute one per-installation Voice Manager instance as both `client.voice` and `context.voice`. Commands and other Seyfert contexts receive the same object and connection registry as the owning client; neither property exists in inferred types when the plugin is absent.

Client and context properties will use Seyfert's plugin contribution inference rather than ambient module augmentation. The package declaration-merges only Seyfert's `CustomEvents` interface, which is the framework's extension contract for the typed `voiceConnectionStateChange` event.
