# @slipher/proxy

Single-replica Discord REST egress proxy for multi-process Seyfert deployments. Central `ApiHandler` contexts own
Discord route buckets and retries; the proxy adds service authentication, token-scoped global gates, an
invalid-request budget, temporary deduplication, admission backpressure, draining, and typed response envelopes.

```text
scaler host A workers ---+
scaler host B workers ---+--> @slipher/proxy --> ApiHandler context(s) --> Discord
auxiliary services ------+
```

The server uses `node:http` and has no native dependencies. Run exactly one replica for the logical deployment. Put it
behind a trusted TLS terminator or encrypted overlay when traffic leaves the local host.

## Install

```sh
pnpm add @slipher/proxy
```

## Server

Generate one credential per service. Store the raw credential only in that service and the hash only in the proxy:

```ts
import { createServiceCredential } from '@slipher/proxy';

const workers = createServiceCredential('scaler-workers');
```

Inject the already configured default `ApiHandler`. If callers use `ApiRequestOptions.token`, provide a factory that
creates a distinct handler for each override:

```ts
import { createProxy } from '@slipher/proxy';
import { ApiHandler } from 'seyfert';

const restOptions = {
	domain: 'https://discord.com',
	baseUrl: 'api/v10',
	workerProxy: false,
} as const;

const rest = new ApiHandler({
	...restOptions,
	token: process.env.DISCORD_TOKEN!,
});

const proxy = await createProxy({
	rest,
	createRestForToken: token => new ApiHandler({ ...restOptions, token }),
	credentials: [
		process.env.WORKERS_CREDENTIAL_HASH!,
		process.env.WORKERS_NEXT_CREDENTIAL_HASH!,
	],
	host: '127.0.0.1',
	port: 4444,
});

process.once('SIGTERM', () => {
	void proxy.close({ drainTimeout: 10_000 });
});
```

Multiple hashes for one `serviceId` allow credential rotation. The raw Discord token is never a service credential.
The default token may rotate through `rest.options.token`; admitted requests retain the token version selected when
they entered the proxy.

Without `createRestForToken`, requests using the initial default token still work. A token override or a later
`rest.options.token` rotation returns `PROXY_TOKEN_CONTEXT_UNAVAILABLE` without dispatching, because sharing the old
handler would mix rate-limit state between token versions.

### Configuration

| Option | Default | Meaning |
|---|---:|---|
| `rest` | required | Exclusive default Discord `ApiHandler` |
| `createRestForToken` | disabled | Factory for isolated override contexts |
| `credentials` | required* | Active static service credential hashes |
| `authenticate` | required* | Custom async authenticator; mutually exclusive with `credentials` |
| `host` | `127.0.0.1` | HTTP bind host |
| `port` | required | HTTP listening port; `0` selects an ephemeral port |
| `maxTokenContexts` | `128` | LRU capacity for override contexts; active, quarantined, or reset-blocked entries are retained |
| `maxAdmittedRequests` | `512` | Body readers, admission queue, and work already handed to Seyfert |
| `queueTimeout` | `5_000` | Maximum wait in the proxy admission queue |
| `maxRequestBytes` | disabled | Maximum encoded bytes for one RPC |
| `maxBufferedBytes` | disabled | Maximum aggregate admitted encoded bytes |
| `maxFiles` | disabled | Maximum files in one RPC |
| `maxMetadataBytes` | disabled | Maximum JSON metadata bytes |
| `deduplication` | `{ ttl: 300_000, maxEntries: 10_000 }` | In-memory `(serviceId, requestId)` registry |
| `globalLimit` | `{ max: 50, perMs: 1_000 }` | Sliding gate per authenticated token context |
| `unauthenticatedLimit` | `{ max: 50, perMs: 1_000 }` | Sliding gate shared by `auth: false` work |
| `invalidWindow` | `{ max: 10_000, perMs: 600_000 }` | Shared invalid-response budget |

\* Configure exactly one authentication mechanism.

`queueTimeout` stops when work is handed to the central `ApiHandler`. Seyfert still owns route-bucket waiting and
Discord retries. `maxAdmittedRequests` and `maxBufferedBytes` continue counting that work, preventing hidden bucket
queues from bypassing backpressure.

`maxAdmittedRequests` limits request count, not memory per request. Production deployments should configure
`maxRequestBytes`, `maxBufferedBytes`, `maxFiles`, and `maxMetadataBytes` from their largest expected payload and
process memory budget.

Discord `401`, `403`, and non-shared `429` responses consume the invalid budget. An authenticated `401` quarantines
only that token fingerprint. A different override or a rotated default token remains usable.

### Health and stats

Every route requires a service credential:

| Route | Result |
|---|---|
| `GET /health/live` | Empty `200` while the process and configured authenticator respond |
| `GET /health/ready` | Empty `200` only while accepting traffic and the default token context is usable |
| `GET /stats` | Detached snapshot from `getStats()` |
| `POST /v1/requests` | Internal REST RPC |

Unknown routes return a typed `PROXY_NOT_FOUND` envelope. `proxy.observe(callback)` emits sanitized lifecycle and
request events. `proxy.getStats()` reports admitted, pending and in-flight requests, buffered bytes, context and
deduplication counts, invalid budget, state, `instanceId`, and outcomes. `authenticatedGateOccupancy` aggregates token
contexts that share the configured authenticated window; `unauthenticatedGateOccupancy` reports the separate
`auth: false` gate. State is `unavailable` when the active default token has no usable context.

No observation or built-in log contains raw Discord routes, bodies, tokens, or service credentials. State events are
emitted only for lifecycle transitions, not every counter update.

## Seyfert client

Install `ProxyApiHandler` before starting each client. Scaler workers must use `workerProxy: false`, so Seyfert does
not replace the injected handler with manager IPC.

```ts
import { ProxyApiHandler } from '@slipher/proxy';
import { WorkerClient } from 'seyfert';

const client = new WorkerClient();
client.setServices({
	rest: new ProxyApiHandler({
		url: 'https://discord-rest.internal',
		credential: process.env.REST_PROXY_CREDENTIAL!,
		// Optional. When omitted, the transport can wait indefinitely.
		requestTimeout: 30_000,
	}),
});

await client.start();
```

Requests without files use JSON. Requests with files use multipart and keep bytes binary. `auth: false` is supported
and ignores any token override. Arbitrary `ApiRequestOptions.token` values select isolated server contexts.

The base URL must contain only scheme and authority. `ProxyApiHandler` owns the versioned `/v1/requests` pathname and
rejects URLs containing a path, query, or hash.

## Deduplication and delivery

Each wire request carries a `requestId`. For five minutes by default:

- an identical in-flight duplicate waits for the same result;
- an identical completed duplicate receives the cached envelope;
- reuse with different method, route, payload, files, or token identity returns `PROXY_REQUEST_ID_CONFLICT`.

The registry is process-local and disappears on restart. It does not provide exactly-once delivery, a status endpoint,
or automatic client retries. Completed and ambiguous results are cached. A queue timeout is also cached because the
operation already consumed its admission turn; other `not_dispatched` results release the ID for a deliberate retry.
Duplicate waiters remain subject to `maxAdmittedRequests` and are included in request outcomes.

`ProxyApiHandler` also mirrors the ID in `X-Proxy-Request-Id`, allowing admission errors produced before body decoding
to preserve the caller's ID. The server rejects a header and payload mismatch.

Discord failures travel over HTTP `200` and are reconstructed as the installed Seyfert version's real
`SeyfertError`. Proxy failures throw `ProxyError` with:

- `code`: stable `PROXY_*` code;
- `phase`: the lifecycle phase that produced the failure;
- `outcome`: `not_dispatched`, `completed`, or `unknown`;
- `requestId`: correlation and deduplication key;
- `instanceId`: server identity when an envelope was received.

Local transport failures cannot include an `instanceId`. A configured client timeout aborts only the local connection;
it never cancels work already handed to the server.

## Development

```sh
pnpm --filter @slipher/proxy build
pnpm --filter @slipher/proxy test
```
