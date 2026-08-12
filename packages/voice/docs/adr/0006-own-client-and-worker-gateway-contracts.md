# Own Client and Worker gateway contracts

`@slipher/voice` will own separate main-Gateway coordination adapters for Seyfert `Client` and `WorkerClient`. Both adapters construct Discord's `Update Voice State` payloads directly and preserve shard selection, rate limiting, and Seyfert's outgoing plugin wrappers; neither delegates joining or leaving to `ShardManager.joinVoice()` or `leaveVoice()`. `HttpClient` has no Gateway contract and is unsupported.
