# Webhook Events

Completely agnostic and minimalistic way with 1 dependencies to listen to Discord webhook events.

```ts
import { init } from '@slipher/webhooks'

const server = init({
	port: 3000,
	path: '/api/webhooks',
	callback: (event) => console.log(event),
	listen: () => console.log('Listen webhooks'),
});
```
### To complete the typing you must use the augmentation module provided by typescript

**Seyfert**
```ts
import type { APIUser, APIGuild, APIEntitlement } from "seyfert/lib/types";

declare module '@slipher/webhooks' {
	export interface EntitlementCreateEventType extends APIEntitlement {}
	export interface UserType extends APIUser {}
	export interface GuildType extends APIGuild {}
}
```