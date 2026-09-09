import { Context } from '@slipher/macros';
import {
	ApplicationCommandType,
	Command,
	ComponentCommand,
	ComponentType,
	ContextMenuCommand,
	createIntegerOption,
	createStringOption,
	Declare,
	EntryPointCommand,
	Middlewares,
	ModalCommand,
	Options,
	SubCommand,
} from 'seyfert';

const options = {
	query: createStringOption({ description: 'Query', required: true }),
	limit: createIntegerOption({ description: 'Limit' }),
};
@Options(options)
@Middlewares(['staff'])
export class ChatHooks extends Command {
	@Context()
	run(ctx) {
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
	}
	@Context()
	onBeforeMiddlewares(ctx) {
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
	}
	@Context()
	onAfterRun(ctx, error) {
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
		// @ts-expect-error thrown error remains unknown
		const message: string = error;
	}
	@Context()
	onRunError(ctx, error) {
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
		// @ts-expect-error thrown error remains unknown
		const message: string = error;
	}
	@Context()
	onMiddlewaresError(ctx, reason, denial) {
		const id: string | undefined = ctx.metadata.staff?.userId;
		// @ts-expect-error middleware chain may fail before staff runs
		const required: string = ctx.metadata.staff.userId;
		const reasonText: string = reason;
		const scope: 'global' | 'command' = denial.scope;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
	}
	@Context()
	onInternalError(client, command, error?) {
		client.logger;
		command.props;
		// @ts-expect-error error is unknown
		const invalid: string = error;
		// @ts-expect-error client must not become any
		client.notAClientProperty;
	}
	@Context()
	onBeforeOptions(ctx) {
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		// @ts-expect-error options have not been resolved
		ctx.options.query;
	}
	@Context()
	onOptionsError(ctx, failures) {
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		const query: string | undefined = ctx.options.query;
		// @ts-expect-error option resolution may fail
		const requiredQuery: string = ctx.options.query;
		const failed: boolean = failures.query.failed;
	}
	@Context()
	onBotPermissionsFail(ctx, permissions) {
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		// @ts-expect-error options have not been resolved
		ctx.options.query;
		// @ts-expect-error permission list is not a number
		const wrongPermissions: number = permissions;
	}
	@Context()
	onPermissionsFail(ctx, permissions) {
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		// @ts-expect-error options have not been resolved
		ctx.options.query;
		// @ts-expect-error permission list is not a number
		const wrongPermissions: number = permissions;
	}
}
@Options(options)
@Middlewares(['staff'])
export class SubHooks extends SubCommand {
	@Context()
	run(ctx) {
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
		const query: string = ctx.options.query;
		const limit: number | undefined = ctx.options.limit;
	}
}
@Middlewares(['staff'])
export class ButtonHooks extends ComponentCommand {
	componentType = 'Button' as const;
	@Context()
	run(ctx) {
		const kind: import('seyfert').ButtonInteraction = ctx.interaction;
		// @ts-expect-error component interaction must not become any
		const notAny: string = ctx.interaction;
		// @ts-expect-error button context has no select values
		ctx.interaction.values;
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
	}
	@Context()
	filter(ctx) {
		const kind: import('seyfert').ButtonInteraction = ctx.interaction;
		// @ts-expect-error component interaction must not become any
		const notAny: string = ctx.interaction;
		// @ts-expect-error button context has no select values
		ctx.interaction.values;
		// @ts-expect-error middleware metadata is not available yet
		ctx.metadata.staff;
		return true;
	}
}
@Middlewares(['staff'])
export class ModalHooks extends ModalCommand {
	@Context()
	run(ctx) {
		const value: string | string[] | undefined = ctx.getInputValue('field');
		// @ts-expect-error modal has no chat options
		ctx.options;
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
	}
}
@Declare({ name: 'usermenuhooks', type: ApplicationCommandType.User })
@Middlewares(['staff'])
export class UserMenuHooks extends ContextMenuCommand {
	@Context()
	run(ctx) {
		const target: string = ctx.target.username;
		// @ts-expect-error wrong menu target
		ctx.target.content;
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
	}
}
@Declare({ name: 'messagemenuhooks', type: ApplicationCommandType.Message })
@Middlewares(['staff'])
export class MessageMenuHooks extends ContextMenuCommand {
	@Context()
	run(ctx) {
		const target: string = ctx.target.content;
		// @ts-expect-error wrong menu target
		ctx.target.username;
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
	}
}
@Middlewares(['staff'])
export class EntryHooks extends EntryPointCommand {
	@Context()
	run(ctx) {
		const entry: import('seyfert').EntryPointInteraction = ctx.interaction;
		// @ts-expect-error entry interaction is not a string
		const notAny: string = ctx.interaction;
		// @ts-expect-error entry point has no chat options
		ctx.options;
		const id: string = ctx.metadata.staff.userId;
		// @ts-expect-error metadata must not be any
		const wrong: number = ctx.metadata.staff.userId;
	}
}
