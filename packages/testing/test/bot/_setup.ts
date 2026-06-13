import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	createMiddleware,
	createStringOption,
	Declare,
	EntryPointCommand,
	type MenuCommandContext,
	type MessageCommandInteraction,
	Middlewares,
	ModalCommand,
	type ModalContext,
	Options,
	type ParseMiddlewares,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, EntryPointCommandHandlerType } from 'seyfert/lib/types';

export const greetOptions = {
	name: createStringOption({ description: 'Who to greet', required: true }),
};

@Declare({ name: 'greet', description: 'Greets someone' })
@Options(greetOptions)
export class GreetCommand extends Command {
	async run(ctx: CommandContext<typeof greetOptions>) {
		await ctx.write({ content: `Hello, ${ctx.options.name}!` });
	}
}

@Declare({ name: 'slow', description: 'Defers then follows up' })
export class SlowCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.deferReply();
		await ctx.editOrReply({ content: 'done' });
		await ctx.followup({ content: 'extra' });
	}
}

export const echoOptions = {
	text: createStringOption({ description: 'What to echo', required: true }),
};

@Declare({ name: 'echo', description: 'Echoes text' })
@Options(echoOptions)
export class EchoCommand extends Command {
	async run(ctx: CommandContext<typeof echoOptions>) {
		await ctx.write({ content: `echo: ${ctx.options.text}` });
	}
}

export class ConfirmButton extends ComponentCommand {
	componentType = 'Button' as const;
	filter(ctx: ComponentContext<'Button'>) {
		return ctx.customId === 'confirm';
	}
	async run(ctx: ComponentContext<'Button'>) {
		await ctx.write({ content: 'Confirmed!' });
	}
}

export class PickSelect extends ComponentCommand {
	componentType = 'StringSelect' as const;
	filter(ctx: ComponentContext<'StringSelect'>) {
		return ctx.customId === 'pick';
	}
	async run(ctx: ComponentContext<'StringSelect'>) {
		await ctx.write({ content: `Picked ${ctx.interaction.values.join(',')}` });
	}
}

export class FeedbackModal extends ModalCommand {
	filter(ctx: ModalContext) {
		return ctx.customId === 'feedback';
	}
	async run(ctx: ModalContext) {
		await ctx.write({ content: 'Thanks!' });
	}
}

export const guardCalls: string[] = [];
export const guard = createMiddleware<void>(middle => {
	guardCalls.push('guard');
	middle.next();
});

export const globalCalls: string[] = [];
export const globalCounter = createMiddleware<void>(middle => {
	globalCalls.push('global');
	middle.next();
});

export const blocker = createMiddleware<void>(middle => {
	middle.stop('blocked');
});

export const testMiddlewares = { blocker, globalCounter, guard };

declare module 'seyfert' {
	interface RegisteredMiddlewares extends ParseMiddlewares<typeof testMiddlewares> {}
}

@Declare({ name: 'guarded', description: 'Guarded command' })
@Middlewares(['guard'])
export class GuardedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'passed' });
	}
}

const searchOptions = {
	query: createStringOption({
		description: 'Search query',
		required: true,
		autocomplete: async interaction => {
			const value = interaction.getInput();
			await interaction.respond([{ name: `result:${value}`, value }]);
		},
	}),
};

@Declare({ name: 'search', description: 'Searches' })
@Options(searchOptions)
export class SearchCommand extends Command {
	async run(ctx: CommandContext<typeof searchOptions>) {
		await ctx.write({ content: ctx.options.query });
	}
}

export class ReportUser extends ContextMenuCommand {
	type = ApplicationCommandType.User as const;
	name = 'Report User';

	async run(ctx: MenuCommandContext<UserCommandInteraction>) {
		await ctx.write({ content: `Reported ${ctx.target.username}` });
	}
}

export class ReportMessage extends ContextMenuCommand {
	type = ApplicationCommandType.Message as const;
	name = 'Report Message';

	async run(ctx: MenuCommandContext<MessageCommandInteraction>) {
		await ctx.write({ content: `Reported message ${ctx.target.id}` });
	}
}

export class LaunchEntryPoint extends EntryPointCommand {
	name = 'launch';
	description = 'Launches';
	handler = EntryPointCommandHandlerType.AppHandler;

	async run(ctx: Parameters<NonNullable<EntryPointCommand['run']>>[0]) {
		await ctx.write({ content: 'launched' });
	}
}

export const sampleCommands = [
	GreetCommand,
	SlowCommand,
	GuardedCommand,
	SearchCommand,
	ReportUser,
	ReportMessage,
	LaunchEntryPoint,
	EchoCommand,
];
export const sampleComponents = [ConfirmButton, PickSelect, FeedbackModal];
