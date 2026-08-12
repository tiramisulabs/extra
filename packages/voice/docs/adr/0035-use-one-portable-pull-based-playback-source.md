# Use one portable pull-based playback source

The playback input contract is `AsyncIterable<Uint8Array>`, with each yielded value containing exactly one complete encoded Opus packet. The Voice Plugin pulls packets according to its own transmission scheduler, parses each packet's Opus TOC to derive its sample duration, and closes an interrupted source through the iterator's `return()` method.

The public contract will use `Uint8Array` rather than Node's `Buffer` and will not add special overloads for Node streams, Web streams, callbacks, arrays, or runtime-specific file handles. Adapters can present those producers through the one async-iterable contract.

Arbitrary byte chunks are not interchangeable with Opus packets. In particular, a file stream must be demultiplexed into complete Opus packets before it becomes a Playback Source; playback never treats filesystem chunk boundaries as media frame boundaries.
