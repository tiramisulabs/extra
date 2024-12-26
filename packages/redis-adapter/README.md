More information in the [docs](https://docs.seyfert.dev/getting-started/declare-module#internal-options)

```ts
import { Client } from 'seyfert';
import { RedisAdapter } from '@slipher/redis-adapter';

const client = new Client();

client.setServices({
    cache: {
        adapter: new RedisAdapter()
    }
});

await client.start();
```
