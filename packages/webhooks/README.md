# @slipher/webhooks

Minimal HTTP listener for Discord webhook events.

## Install

```sh
pnpm add @slipher/webhooks
```

## Usage

```ts
import { init } from '@slipher/webhooks';

const server = init({
	port: 3000,
	path: '/api/webhooks',
	publicKey: process.env.DISCORD_PUBLIC_KEY!,
	callback: event => {
		console.log(event);
	},
	listen: () => console.log('Listening for webhooks'),
});
```

The listener accepts `POST` requests at the configured `path`, verifies Discord's Ed25519 signature with `x-signature-timestamp`, `x-signature-ed25519`, and `publicKey`, then calls `callback` for event payloads.

## Responses

- Non-`POST` requests return `405`.
- Requests to another path return `401`.
- Invalid signatures return `401`.
- Malformed JSON or non-object JSON returns `400`.
- Bodies larger than 1 MB return `413`.
- Valid Discord ping and event payloads return `204`.

## Type Augmentation

To complete the event typing, augment the webhook interfaces with your API types.

**Seyfert**

```ts
import type { APIEntitlement, APIGuild, APIUser } from 'seyfert/lib/types';

declare module '@slipher/webhooks' {
	export interface EntitlementCreateEventType extends APIEntitlement {}
	export interface UserType extends APIUser {}
	export interface GuildType extends APIGuild {}
}
```

## Development

```sh
pnpm --filter @slipher/webhooks test
pnpm --filter @slipher/webhooks build
```
