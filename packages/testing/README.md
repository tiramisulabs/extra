# @slipher/testing

Small testing utilities for Seyfert bots and Slipher packages.

The package is test-runner agnostic: it records calls and responses without depending on Vitest, Jest, or Node's test runner.

Status: beta/draft. The package is usable, but public API details may change before a stable release.

## Install

```sh
pnpm add -D @slipher/testing
```

## Mock command contexts

```ts
import { createMockCommandContext, getLastResponse } from '@slipher/testing';

const ctx = createMockCommandContext({
	commandName: 'ping',
	userId: '123',
	guildId: '456',
});

await command.run(ctx as never);

console.log(ctx.write.callCount);
console.log(getLastResponse(ctx));
```

## Record arbitrary calls

```ts
import { createRecorder } from '@slipher/testing';

const send = createRecorder<[string], string>().returns('ok');

await send('hello');

console.log(send.calls); // [['hello']]
```

## Fake clocks

```ts
import { FakeClock } from '@slipher/testing';

const clock = new FakeClock();

clock.advanceSeconds(10);
console.log(clock.now()); // 10000
```
