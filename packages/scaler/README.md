# @slipher/scaler

Run vanilla Seyfert `WorkerClient` processes across a small set of hosts.

**[Read the complete Scaling guide on seyfert.dev](https://seyfert.dev/docs/learn/scaling).**

## Install

```sh
pnpm add @slipher/scaler seyfert
```

Requires Node.js 22.13 or newer and Seyfert v5.

## Quick start

After configuring the master topology and placement, run one agent on each worker host:

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

The worker remains a standard Seyfert `WorkerClient`. TLS is required outside loopback unless `allowInsecureTransport: true` explicitly opts into a trusted private overlay.

Host-loss replacement is deliberately manual by default because replacing a partitioned host can connect duplicate shards. Enable `autoRePlaceOnHostLoss` only when that risk is acceptable.
