import { Context } from '@slipher/macros';
import { ComponentCommand } from 'seyfert';
import { CustomId as Route } from './custom-id.js';

@Route('user:{userId}')
export class UserButton extends ComponentCommand {
	componentType = 'Button' as const;
	seen: string[] = [];
	results: string[] = [];

	@Context()
	onBeforeMiddlewares(ctx) {
		// @ts-expect-error The extension does not advertise this hook.
		ctx.params;
	}

	@Context()
	async filter(ctx) {
		this.seen.push(ctx.params.userId);
		return ctx.params.userId !== 'denied';
	}

	@Context()
	run(ctx) {
		const userId: string = ctx.params.userId;
		// @ts-expect-error Only the declared parameter exists.
		ctx.params.other;
		this.results.push(userId);
		return userId;
	}
}

@Route('page::{pageId}::user::{userId}', '::')
export class PageButton extends ComponentCommand {
	componentType = 'Button' as const;

	@Context()
	run(ctx) {
		const page: string = ctx.params.pageId;
		const user: string = ctx.params.userId;
		return [page, user];
	}
}
