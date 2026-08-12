# Expose connections through a read-only registry

`client.voice` will keep its action methods `connect()` and `disconnect()`, while connection lookup and enumeration live under `client.voice.connections`. The latter is a live `ReadonlyMap<string, VoiceConnection>` view keyed by guild ID, supporting the standard read-only map surface such as `get`, `has`, `size`, iteration, and `values`. Holding the view observes later registry changes.

The public surface does not place collection methods directly on `client.voice` and does not expose `set`, `delete`, or `clear`. A connection remains in the registry through connecting, ready, moving, recovering, and disconnecting states and is removed when it becomes destroyed.
