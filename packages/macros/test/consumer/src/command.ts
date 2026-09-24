import { Context as AutoContext, Context } from '@slipher/macros';
import {
	Command,
	Options as CommandOptions,
	createIntegerOption,
	createMiddleware,
	createStringOption,
	Declare,
	Middlewares,
	SubCommand,
} from 'seyfert';

const registeredMiddlewares = {
	staff: createMiddleware<{ userId: string }>(({ next }) => next({ userId: 'staff-user' })),
};
declare module 'seyfert' {
	interface SeyfertRegistry {
		middlewares: typeof registeredMiddlewares;
	}
}

const options = {
	query: createStringOption({ description: 'Search query', required: true }),
	limit: createIntegerOption({ description: 'Maximum results' }),
};

@Declare({ name: 'search', description: 'Search with inferred context' })
@CommandOptions(options)
@Middlewares(['staff'])
export class Search extends Command {
	@Context()
	async run(ctx) {
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
		const userId: string = ctx.metadata.staff.userId;
		// @ts-expect-error query must not become any
		const wrong: number = ctx.options.query;
		// @ts-expect-error optional limit must preserve undefined
		const required: number = ctx.options.limit;
		// @ts-expect-error unknown options are rejected
		ctx.options.missing;
		// @ts-expect-error middleware metadata stays typed
		const wrongId: number = ctx.metadata.staff.userId;
		return { query, limit, userId };
	}
}

@Declare({ name: 'ping', description: 'No options or middleware' })
export class Ping extends Command {
	@AutoContext()
	async run(ctx) {
		// @ts-expect-error options must not leak from Search
		ctx.options.query;
		// @ts-expect-error middleware must not leak from Search
		ctx.metadata.staff;
		return ctx.options;
	}
}

const selectedMiddlewares = ['staff'] as const;

@Declare({ name: 'named', description: 'Named middleware tuple' })
@Middlewares(selectedMiddlewares)
export class Named extends SubCommand {
	@AutoContext()
	async run(ctx) {
		return ctx.metadata.staff.userId;
	}
}
