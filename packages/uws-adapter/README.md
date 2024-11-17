```ts
import { UwsAdapter } from "@slipher/uws-adapter";
import { HttpClient } from "seyfert";

const client = new HttpClient(); // HttpClient, Client, or WorkerClient
const adapter = new UwsAdapter(client);

await adapter.start();
await client.start();
```
