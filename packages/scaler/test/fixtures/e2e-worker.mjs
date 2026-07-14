// Seyfert 5.0.0's custom Node socket drops the URL port and uses HTTPS/443.
// Defining Bun forces its WHATWG WebSocket branch, whose gateway subset works
// with Node 22's global WebSocket and an ephemeral ws:// test port. This does
// not cover BaseSocket.ping or Seyfert's custom Node socket implementation.
globalThis.Bun = {};

const { WorkerClient } = await import('seyfert');

const client = new WorkerClient({
	getRC() {
		return {
			token: process.env.SEYFERT_WORKER_TOKEN ?? 'e2e-token',
			intents: 0,
			locations: { base: process.cwd() },
		};
	},
});

await client.start();
