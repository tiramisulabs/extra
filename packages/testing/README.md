# @slipher/testing

Runner-agnostic fixtures for testing Seyfert bots.

## Install

```sh
pnpm add -D @slipher/testing
```

## Mock command contexts

```ts
import { mockCommandContext, mockUser } from '@slipher/testing';
import { expect, test } from 'vitest';

test('command replies', async () => {
	const ctx = mockCommandContext({
		commandName: 'ban',
		options: { user: mockUser({ id: '123' }) },
	});

	await command.run(ctx as never);

	expect(ctx.responses.at(-1)).toMatchObject({ content: expect.stringContaining('Banned') });
});
```

## Factories

```ts
import { mockChannel, mockGuild, mockMember, mockUser } from '@slipher/testing';

const user = mockUser();
const guild = mockGuild();
const channel = mockChannel({ guildId: guild.id });
const member = mockMember({ user });
```

This package does not provide spies, fake timers, or assertion helpers. Use the test runner you already have for those.
