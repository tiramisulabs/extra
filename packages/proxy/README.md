# @slipher/proxy

Single-replica Discord REST egress proxy for multi-process Seyfert deployments. One central `ApiHandler` owns all
Discord route buckets and retries; the proxy adds service authentication, a proactive global gate, an invalid-request
budget, admission backpressure, draining, and typed response envelopes.

```text
scaler host A workers ---+
scaler host B workers ---+--> @slipher/proxy --> central ApiHandler --> Discord
auxiliary services ------+
```

The server uses `node:http` and has no native dependencies. Run exactly one replica for a bot token. Put it behind a
trusted TLS terminator or a trusted encrypted overlay when traffic leaves the local host.

## Install

```sh
pnpm add @slipher/proxy
```

## Server

Generate a service credential once. Store the raw credential only in the service and the hash only in the proxy:

```ts
import { createServiceCredential } from '@slipher/proxy';

const workers = createServiceCredential('scaler-workers');
// Store workers.credential in the service secret store.
// Store workers.hash in the proxy configuration.
```

Start the proxy with one or more active hashes. Multiple hashes for the same `serviceId` allow rotation without
downtime:

```ts
import { createProxy } from '@slipher/proxy';

const proxy = await createProxy({
	token: process.env.DISCORD_TOKEN!,
	credentials: [process.env.WORKERS_CREDENTIAL_HASH!, process.env.WORKERS_NEXT_CREDENTIAL_HASH!],
	port: 4444,
});

process.once('SIGTERM', () => {
	void proxy.close({ drainTimeout: 10_000 });
});
```

The raw bot token is never a service credential. `serviceId` comes only from the matching stored credential hash; a
client cannot declare it.

### Configuration

| Option | Default | Meaning |
|---|---:|---|
| `token` | required | Central Discord bot token |
| `credentials` | required | Active hashes created by `createServiceCredential` or `hashServiceCredential` |
| `port` | required | HTTP listening port; `0` selects an ephemeral port |
| `maxPendingRequests` | `512` | Maximum requests waiting for dispatch |
| `queueTimeout` | `5_000` | Maximum admission wait in milliseconds |
| `maxRequestBytes` | `10 MiB` | Maximum encoded request size |
| `invalidWindow` | `{ max: 10_000, perMs: 600_000 }` | Invalid-response budget |

The proactive gate admits at most 50 requests per sliding second. Identifiable interaction callback routes are exempt;
other `auth: false` requests still use the gate. Discord `401`, `403`, and non-shared `429` responses consume the
invalid budget. An authenticated Discord `401` quarantines the process until it restarts with a valid token.

### Health and stats

| Route | Authentication | Result |
|---|---|---|
| `GET /health/live` | no | Empty `200` while the process responds |
| `GET /health/ready` | Bearer | Empty `200` only while accepting traffic |
| `GET /stats` | Bearer | Snapshot from `getStats()` |
| `POST /api` | Bearer | Internal REST RPC |

`proxy.observe(callback)` emits sanitized lifecycle/request events. `proxy.getStats()` reports pending and in-flight
requests, global-gate occupancy, invalid budget remaining, state, `instanceId`, and outcome counters. Observations and
logs never contain raw Discord routes, bodies, bot tokens, or service credentials.

## Seyfert client

Install a `ProxyApiHandler` before starting each client. Scaler workers must be created with `workerProxy: false` so
Seyfert does not replace the injected handler with its manager IPC proxy.

```ts
import { ProxyApiHandler } from '@slipher/proxy';
import { WorkerClient } from 'seyfert';

const client = new WorkerClient();
client.setServices({
	rest: new ProxyApiHandler({
		url: 'https://discord-rest.internal',
		credential: process.env.REST_PROXY_CREDENTIAL!,
	}),
});

await client.start();
```

Requests without files use JSON. Requests with files use multipart and keep file bytes binary. `route` and `unshift`
are intentionally not sent: the central `ApiHandler` owns scheduling. `auth: false` is supported. A per-request
`ApiRequestOptions.token` override throws `PROXY_TOKEN_OVERRIDE_UNSUPPORTED` before dispatch.

## Errors and delivery outcomes

Discord failures are returned over HTTP `200` and reconstructed as the installed Seyfert version's real
`SeyfertError`, including structured `code`/`metadata` and a stack captured at the local call site.

Proxy and transport failures throw `ProxyError` with:

- `code`: stable `PROXY_*` code.
- `outcome: 'not_dispatched'`: safe to retry because the request never reached the central handler.
- `outcome: 'completed'`: the operation finished and must not be repeated blindly.
- `outcome: 'unknown'`: delivery is ambiguous; verify the Discord-side state before retrying a non-idempotent action.
- `requestId`: correlation only, never an idempotency key.

There are no automatic service-to-proxy retries or request deduplication. The central Seyfert handler still owns its
normal Discord `429`, `502`, and `503` retries.

## Migrating from 0.0.7

0.0.7 authenticated requests with the Discord bot token and exposed only `createProxy`. In v1:

1. Generate a service credential and configure its hash in `createProxy({ credentials: [...] })`.
2. Replace `Authorization: Bot <discord-token>` with `ProxyApiHandler({ credential: <service-credential> })`.
3. Set scaler workers to `workerProxy: false` and inject the handler with `setServices({ rest })`.

Do not send the bot token to clients as the proxy credential. The server still owns the bot token and the only
Discord-facing `ApiHandler`.

## Development

```sh
pnpm --filter @slipher/proxy build
pnpm --filter @slipher/proxy test
```
