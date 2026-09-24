import { Context } from '@slipher/macros';
import {
	Command,
	ComponentCommand,
	ContextMenuCommand,
	createStringOption,
	EntryPointCommand,
	Middlewares,
	ModalCommand,
	Options,
	SubCommand,
} from 'seyfert';

const options = { query: createStringOption({ description: 'Query', required: true }) };
@Options(options)
@Middlewares(['staff'])
export class FlowCommand extends Command {
	events: string[] = [];
	fail = false;
	@Context() onBeforeOptions(ctx) {
		if (Object.keys(ctx.options).length) throw Error('Options existed too early');
		this.events.push('options:before');
	}
	@Context() onOptionsError(ctx, failures) {
		if (ctx.options.query !== undefined || !failures.query.failed) throw Error('Invalid failed options');
		this.events.push('options:failed');
	}
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
@Options(options)
@Middlewares(['staff'])
export class FlowSubCommand extends SubCommand {
	events: string[] = [];
	fail = false;
	@Context() onBeforeOptions(ctx) {
		if (Object.keys(ctx.options).length) throw Error('Options existed too early');
		this.events.push('options:before');
	}
	@Context() onOptionsError(ctx, failures) {
		if (ctx.options.query !== undefined || !failures.query.failed) throw Error('Invalid failed options');
		this.events.push('options:failed');
	}
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
@Middlewares(['staff'])
export class FlowComponentCommand extends ComponentCommand {
	events: string[] = [];
	fail = false;
	componentType = 'Button' as const;
	@Context() filter(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed during filter');
		this.events.push('filter');
		return true;
	}
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
@Middlewares(['staff'])
export class FlowModalCommand extends ModalCommand {
	events: string[] = [];
	fail = false;
	@Context() filter(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed during filter');
		this.events.push('filter');
		return true;
	}
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
@Middlewares(['staff'])
export class FlowContextMenuCommand extends ContextMenuCommand {
	events: string[] = [];
	fail = false;
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
@Middlewares(['staff'])
export class FlowEntryPointCommand extends EntryPointCommand {
	events: string[] = [];
	fail = false;
	@Context() onBeforeMiddlewares(ctx) {
		if (Object.keys(ctx.metadata).length) throw Error('Metadata existed too early');
		this.events.push('before');
	}
	@Context() run(ctx) {
		this.events.push('run:' + ctx.metadata.staff.userId);
		if (this.fail) throw Error('run failed');
	}
	@Context() onRunError(ctx, error) {
		if (!(error instanceof Error)) throw Error('Missing run error');
		this.events.push('error:' + ctx.metadata.staff.userId);
	}
	@Context() onAfterRun(ctx, error) {
		this.events.push('after:' + ctx.metadata.staff.userId + ':' + (error === undefined ? 'ok' : 'error'));
	}
	@Context() onMiddlewaresError(ctx, reason, denial) {
		if (ctx.metadata.staff !== undefined || reason !== 'denied' || denial.scope !== 'command')
			throw Error('Incorrect denial');
		this.events.push('denied');
	}
	@Context() onInternalError(client, command, error) {
		if (!(error instanceof Error) || command !== this || !client.logger) throw Error('Invalid internal error');
		this.events.push('internal');
	}
}
