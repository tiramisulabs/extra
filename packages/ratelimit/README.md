# @slipher/ratelimit

Typed quota and traffic control for Seyfert bots, Discord services, webhooks, proxies, and background jobs.

Unlike a command cooldown, a rate limiter can protect shared resources such as paid APIs, expensive image/chart rendering, guild-wide daily quotas, webhook endpoints, queues, and REST proxies.

## Install

```sh
pnpm add @slipher/ratelimit
```

## Basic usage

```ts
import { RateLimiter } from '@slipher/ratelimit';

const limiter = new RateLimiter({
	name: 'image-generation',
	limit: 10,
	window: '1h',
	key: ctx => ['guild', ctx.guildId],
});

const result = await limiter.consume(ctx);

if (!result.allowed) {
	await ctx.write({
		content: `This server hit its image quota. Try again in ${result.retryAfterSeconds}s.`,
		flags: 64,
	});
}
```

## Dynamic limits

Use dynamic limits for free, premium, and enterprise plans.

```ts
const aiQuota = new RateLimiter({
	name: 'ai-daily-budget',
	window: '1d',
	limit: async ctx => {
		const plan = await getGuildPlan(ctx.guildId);
		if (plan === 'enterprise') return 100_000;
		if (plan === 'premium') return 10_000;
		return 1_000;
	},
	key: ctx => ['guild', ctx.guildId, 'ai'],
});

const result = await aiQuota.consume(ctx, { cost: estimatedTokens });
```

## Shared store

Each limiter uses an in-memory store by default. Pass a store to share state between limiters or to plug in a distributed backend.

```ts
import { MemoryRateLimitStore, RateLimiter } from '@slipher/ratelimit';

const store = new MemoryRateLimitStore();

const limiter = new RateLimiter({
	limit: 50,
	window: '1m',
	key: request => request.headers.get('x-forwarded-for') ?? 'unknown',
	store,
});
```
