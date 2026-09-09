import { Context, GuildContext, GuildContext as ServerContext } from '@slipher/macros';
import {
	ApplicationCommandType,
	Command,
	ComponentCommand,
	ContextMenuCommand,
	createStringOption,
	Declare,
	EntryPointCommand,
	Middlewares,
	ModalCommand,
	Options,
	SubCommand,
} from 'seyfert';

const options = { query: createStringOption({ description: 'Query', required: true }) };

@Options(options)
@Middlewares(['staff'])
export class GuildChat extends Command {
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		const query: string = ctx.options.query;
		const staff: string = ctx.metadata.staff.userId;
		ctx.member.user;
		// @ts-expect-error guildId must not become any
		const invalid: number = ctx.guildId;
		// @ts-expect-error required options stay typed
		const invalidOption: number = ctx.options.query;
		return { id, query, staff };
	}
	@GuildContext()
	onBeforeMiddlewares(ctx) {
		const id: string = ctx.guildId;
		const query: string = ctx.options.query;
		// @ts-expect-error Guild context does not imply completed middlewares
		ctx.metadata.staff;
		return id;
	}
	@GuildContext()
	onMiddlewaresError(ctx, reason, denial) {
		const id: string = ctx.guildId;
		const staff: string | undefined = ctx.metadata.staff?.userId;
		// @ts-expect-error Guild context still has partial middleware metadata on denial
		const required: string = ctx.metadata.staff.userId;
		return { id, staff };
	}
	@GuildContext()
	onOptionsError(ctx, failures) {
		const id: string = ctx.guildId;
		// @ts-expect-error Guild context does not imply resolved options
		const query: string = ctx.options.query;
		return id;
	}
	@Context()
	onAfterRun(ctx, error) {
		// @ts-expect-error A Guild marker on run does not narrow other methods
		const id: string = ctx.guildId;
		return ctx.guildId;
	}
}
export class GuildSub extends SubCommand {
	@ServerContext()
	run(ctx) {
		const id: string = ctx.guildId;
		return id;
	}
}
export class GuildButton extends ComponentCommand {
	componentType = 'Button' as const;
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		const interaction: import('seyfert').ButtonInteraction = ctx.interaction;
		ctx.member.user;
		// @ts-expect-error Guild button must not become a select
		ctx.interaction.values;
		return id;
	}
}
export class GuildModal extends ModalCommand {
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		ctx.member.user;
		return ctx.getInputValue('field');
	}
}
@Declare({ name: 'guild-user', type: ApplicationCommandType.User })
export class GuildUserMenu extends ContextMenuCommand {
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		ctx.member.user;
		const user: string = ctx.target.username;
		return id;
	}
}
@Declare({ name: 'guild-message', type: ApplicationCommandType.Message })
export class GuildMessageMenu extends ContextMenuCommand {
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		ctx.member.user;
		const content: string = ctx.target.content;
		return id;
	}
}
export class GuildEntry extends EntryPointCommand {
	@GuildContext()
	run(ctx) {
		const id: string = ctx.guildId;
		ctx.member.user;
		const interaction: import('seyfert').EntryPointInteraction = ctx.interaction;
		return id;
	}
}
