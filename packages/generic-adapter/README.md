```ts
import { GenericAdapter } from "@slipher/generic-adapter";
import { HttpClient } from "seyfert";

const client = new HttpClient(); // HttpClient, Client, or WorkerClient
const adapter = new GenericAdapter(client);

await adapter.start();
await client.start();

export default {
	fetch(req: Request) {
		return adapter.fetch(req);
	},
};
```
