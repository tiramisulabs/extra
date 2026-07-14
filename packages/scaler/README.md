# @slipher/scaler

Run vanilla Seyfert `WorkerClient` processes across a small set of hosts.

This package is for a bot that no longer fits on one machine and needs explicit worker placement, sequential rolling deploys, local process supervision, and control-plane restarts without taking the bot down. It is not a general-purpose cluster orchestrator.

## Lifecycle

Each logical worker owns an immutable contiguous shard range.

```text
initial: unassigned -> launching -> routed
handoff: routed -> stopping -> unassigned -> launching(target) -> routed
```

A handoff never intentionally overlaps two processes for one logical worker. The source exits before the target launches, so moving a worker has a bounded Discord event gap.

Budget roughly 1 second of post-close grace, a 5.5-second launch gate, at least 5.5 seconds between grants in the same Discord IDENTIFY bucket, and Discord's IDENTIFY/READY latency for each handoff, in addition to shard-close acknowledgement and process startup.

The agent runs the manager side of Seyfert's existing cluster protocol:

```text
WORKER_START -> SPAWN_SHARDS
CONNECT_QUEUE -> global IDENTIFY gate -> ALLOW_CONNECT
WORKER_READY -> routed
HEARTBEAT -> ACK_HEARTBEAT
```

The worker itself is unchanged:

```ts
import { WorkerClient } from 'seyfert';

const client = new WorkerClient();
await client.start();
```

## Operational guarantees

- Allocation traffic is fenced by an opaque `{ slot, token }`; every local respawn gets a fresh token.
- The master serializes IDENTIFY per Discord concurrency bucket with a 5.5-second gate.
- Agents keep workers alive while the master is unavailable and report them again after reconnecting.
- A restarted master adopts exactly one compatible worker whose id and shard range match the configured topology. Ready workers are routed immediately; launching workers are adopted only after they report ready. Incompatible or duplicate observations are stopped.
- Unexpected process exits are respawned locally with capped exponential backoff.
- Transport messages are JSON over `ws`, so master and agents may run different supported Node versions.
- TLS is required outside loopback unless `allowInsecureTransport: true` explicitly opts into a trusted private overlay.

## Recovering from host loss

By default, losing contact with a host emits `downtime` for each affected worker and withdraws its routes, but does **not** launch replacements elsewhere. A control plane cannot distinguish a dead host from a network partition, and replacement could connect duplicate shards.

After confirming that the old host is down, place one worker with `assign` or all workers that fit with `reconcile`:

```ts
scaler.on('downtime', (workerId, error) => {
  console.error(`Worker ${workerId} is down`, error);
});

await scaler.assign(0, { hostId: 'host-b', bootId: 'host-b-boot' });
await scaler.assign(1); // Use the configured placement strategy.
await scaler.reconcile(); // Attempt every remaining unassigned worker.
```

`assign` rejects routed workers; use `handoff` to move a live worker. `reconcile` continues after individual placement failures and throws an `AggregateError` containing every failure after all unassigned workers have been attempted.

`autoRePlaceOnHostLoss: true` performs the same recovery automatically when remaining hosts have capacity. It is deliberately opt-in. Manual or automatic assignment while the old host is partitioned can create two gateway sessions for the same shards, causing events and commands to be processed twice until that host reconnects and its stale worker is stopped.

## Unsupported

- automatic scale-up or rebalance when a host joins;
- changing the total shard count;
- moving individual shards instead of logical workers;
- exactly-once event effects;
- Seyfert `workerProxy` and `WorkerAdapter` manager RPC.

Use normal REST clients inside each worker. For cache shared across hosts, use `@slipher/redis-adapter`; a process-local cache is also valid when cold cache after a move is acceptable.

`postMessage` payloads must be JSON-serializable.

## Events and states

| Source | Event/state | Meaning |
| --- | --- | --- |
| `SeyfertScaler` | `assignment` | A logical worker changed placement or lifecycle state. |
| `SeyfertScaler` | `downtime` | A worker exited or its host became unreachable and no route is currently published. |
| `SeyfertScaler` | `stale` | A READY/topology/local-respawn report or worker message does not match the current allocation. |
| `SeyfertScaler` | `workerMessage` | The current routed worker sent an application message. |
| `ScalerAgent` | `state` → `connecting` | The agent is opening and authenticating its control-plane connection. |
| `ScalerAgent` | `state` → `authenticated` | HELLO completed and the agent can accept master commands. |
| `ScalerAgent` | `state` → `disconnected` | Workers stay alive while the agent retries the control-plane connection. |
| `ScalerAgent` | `state` → `stopped` | The agent was deliberately stopped and its managed workers were drained. |

## Worker environment

Worker environments are deliberately clean: the runner does not inherit agent variables such as `PATH` or `HOME`. Children receive the classic `SEYFERT_WORKER_*` variables plus only the values explicitly configured on the launch factory:

```ts
const createLaunch = createSeyfertLaunch({
  config: botConfig,
  topology,
  workerPath,
  env: {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    APP_ENV: 'production',
  },
});
```

The worker's `seyfert.config` should read `SEYFERT_WORKER_TOKEN` before the parent process token variable because agents do not inherit the master's environment:

```js
token: process.env.SEYFERT_WORKER_TOKEN ?? process.env.BOT_TOKEN ?? ''
```

## Stopping workers

The runner first asks Seyfert to close every shard, which stops new gateway events, and waits for the acknowledgement or `disconnectTimeoutMs`. `terminationGraceMs` then provides a one-second default buffer for microtasks and in-flight replies; it is not a long-running drain mechanism. After that buffer the runner sends SIGTERM, waits `killGraceMs` (five seconds by default), and sends SIGKILL only if the worker has not exited.

Workers that need a longer drain should install a SIGTERM handler and finish within `killGraceMs`:

```ts
process.once('SIGTERM', () => {
  void drainResources().then(
    () => process.exit(0),
    error => {
      console.error(error);
      process.exit(1);
    },
  );
});
```

## Master

```ts
import { ApiHandler, Client } from 'seyfert';
import {
  createLogicalWorkers,
  createSeyfertLaunch,
  resolveShardTopology,
  ScalerMaster,
  SeyfertScaler,
} from '@slipher/scaler/master';

const botConfig = await new Client().getRC();
const api = new ApiHandler({ token: botConfig.token });
const topology = await resolveShardTopology({
  getGatewayBot: () => api.proxy.gateway.bot.get(),
  shardsPerWorker: 4,
});

const master = new ScalerMaster({
  authToken: process.env.SCALER_TOKEN!,
  host: '127.0.0.1',
  port: 8765,
});

const scaler = new SeyfertScaler({
  master,
  workers: createLogicalWorkers(topology),
  createLaunch: createSeyfertLaunch({
    config: botConfig,
    topology,
    workerPath: '/srv/bot/worker.js',
  }),
});

await scaler.start();
```

## Agent

```ts
import { ScalerAgent } from '@slipher/scaler/agent';

const agent = new ScalerAgent({
  hostId: process.env.HOST_ID!,
  host: '127.0.0.1',
  port: 8765,
  authToken: process.env.SCALER_TOKEN!,
  capacity: { maxWorkers: 4 },
});

await agent.start();
```

## Rolling deploy

Deploy the new worker artifact to the desired host, then hand off workers sequentially. The target may be the same host; the scaler waits for exact source exit before reusing its capacity.

```ts
for (const [workerId, assignment] of scaler.assignments) {
  if (assignment.state !== 'routed') continue;
  await scaler.handoff(workerId, assignment.placement);
}
```
