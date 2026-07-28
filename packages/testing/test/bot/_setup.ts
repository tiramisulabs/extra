import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	ContextMenuCommand,
	createIntegerOption,
	createMiddleware,
	createStringOption,
	Declare,
	EntryPointCommand,
	Group,
	Groups,
	type MenuCommandContext,
	type MessageCommandInteraction,
	Middlewares,
	ModalCommand,
	type ModalContext,
	Options,
	SubCommand,
	type UserCommandInteraction,
} from 'seyfert';
import { ApplicationCommandType, EntryPointCommandHandlerType } from 'seyfert/lib/types';
import { expect } from 'vitest';
import { apiUser } from '../../src/bot/payloads';
import { type DiscordErrorInit, isDiscordError } from '../../src/bot/rest';
import { mockWorld } from '../../src/bot/world';

/**
 * The descriptive text Discord sent. seyfert's `parseError` names the error `API_<statusText>_<code>` and uses
 * that as `.message` — a Missing Permissions failure reads `Api Forbidden 50013` — but it keeps the body it
 * parsed on `metadata.response`, which is where the per-call copy survives.
 */
export function discordErrorDetail(error: unknown): string | undefined {
	const response = (error as { metadata?: { response?: { message?: unknown } } } | null | undefined)?.metadata
		?.response;
	return typeof response?.message === 'string' ? response.message : undefined;
}

function describeThrown(error: unknown): string {
	if (!(error instanceof Error)) return `a non-Error ${JSON.stringify(error)}`;
	const detail = discordErrorDetail(error);
	return `${error.constructor.name} ${error.message}${detail === undefined ? '' : ` (${detail})`}`;
}

/**
 * Assert a call fails with one Discord REST error, by the fields Discord actually sends.
 *
 * The message is deliberately not the subject: seyfert builds it from the status text and the code, so
 * matching it pins seyfert's formatting rather than the mock's behaviour, and it goes green for any error
 * that happens to be worded the same. `detail` is for the errors whose text carries per-call information the
 * code does not — Invalid Form Body naming the offending field — and matches what Discord sent, not what
 * seyfert renamed it to.
 */
export async function expectDiscordError(
	call: PromiseLike<unknown>,
	expected: DiscordErrorInit,
	detail?: RegExp,
): Promise<void> {
	const thrown = await Promise.resolve(call).then(
		value => ({ resolved: value }),
		(reason: unknown) => ({ rejected: reason }),
	);
	if (!('rejected' in thrown)) {
		expect.fail(
			`expected a Discord ${expected.status}/${expected.code ?? 0} rejection, but the call resolved with ` +
				`${JSON.stringify(thrown.resolved)}`,
		);
	}
	const error = thrown.rejected;
	expect(
		isDiscordError(error, { status: expected.status, code: expected.code }),
		`expected a Discord ${expected.status}/${expected.code ?? 0} error, got ${describeThrown(error)}`,
	).toBe(true);
	if (detail !== undefined) expect(discordErrorDetail(error)).toMatch(detail);
}

/** The common test opener: `const { world, guild, actor, channel } = seedGuildFixture('tag')`. */
export function seedGuildFixture(tag: string) {
	const world = mockWorld();
	const guild = world.registerGuild({ id: `${tag}-guild` });
	const actor = world.registerMember(guild.id, { user: apiUser({ id: `${tag}-actor` }) });
	const channel = world.registerChannel(guild.id, { id: `${tag}-chan` });
	return { world, guild, actor, channel };
}

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

// Feature-gate pattern: stop() silently skips the command's run (no error, no reply).
export const skipper = createMiddleware<void>(middle => {
	middle.stop();
});

// Production guard pattern: deny by replying and returning, WITHOUT next()/stop().
export const denierCalls: string[] = [];
export const denier = createMiddleware<void>(middle => {
	denierCalls.push('denier');
	middle.context.editOrReply({ content: 'denied' });
});

export const slowDenierCalls: string[] = [];
/** Channel the slowDenier guard fetches before replying; the test stubs that GET with a slow responder. */
export const SLOW_DENIER_CHANNEL_ID = 'slow-denier-channel';
// Realistic guard: deny without next/stop. It kicks off a slow REST lookup (a channel fetch) and only
// replies once that resolves, returning synchronously so the chain is never progressed and the middleware
// promise settles immediately. The lookup stays in flight across several macrotasks; the denial reply's
// callback request lands only after it. A fixed single-tick denial settle would finalize the dispatch between
// the two and drop the reply. The REST-quiescence drain keeps waiting while a request is in flight.
export const slowDenier = createMiddleware<void>(middle => {
	slowDenierCalls.push('slowDenier');
	const ctx = middle.context as {
		client: { channels: { fetch(id: string): Promise<unknown> } };
		editOrReply(body: { content: string }): Promise<unknown>;
	};
	void ctx.client.channels.fetch(SLOW_DENIER_CHANNEL_ID).then(() => ctx.editOrReply({ content: 'denied' }));
});

// Custom-decorator gate pattern: a user decorator sets `requiredRoles` on the command; this middleware reads
// it off ctx.command and stops the chain when the invoking member lacks every required role.
export const requireRoles = createMiddleware<void>(middle => {
	const required = (middle.context.command as { requiredRoles?: string[] }).requiredRoles;
	if (required?.length) {
		const held = middle.context.member?.roles.keys ?? [];
		if (!required.some(roleId => held.includes(roleId))) return middle.stop('missing-role');
	}
	middle.next();
});

export const testMiddlewares = { blocker, denier, globalCounter, guard, requireRoles, skipper, slowDenier };

declare module 'seyfert' {
	interface SeyfertRegistry {
		middlewares: typeof testMiddlewares;
	}
}

@Declare({ name: 'guarded', description: 'Guarded command' })
@Middlewares(['guard'])
export class GuardedCommand extends Command {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'passed' });
	}
}

export const deniedBodyRan: string[] = [];

@Declare({ name: 'denied', description: 'Denied command' })
@Middlewares(['denier'])
export class DeniedCommand extends Command {
	async run(ctx: CommandContext) {
		deniedBodyRan.push('run');
		await ctx.write({ content: 'should not run' });
	}
}

@Declare({ name: 'slow-denied', description: 'Denied by a multi-hop async guard' })
@Middlewares(['slowDenier'])
export class SlowDeniedCommand extends Command {
	async run(ctx: CommandContext) {
		deniedBodyRan.push('run');
		await ctx.write({ content: 'should not run' });
	}
}

@Declare({ name: 'set', description: 'Set a config value' })
export class ConfigSetSub extends SubCommand {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'set' });
	}
}

@Declare({ name: 'config', description: 'Config command' })
@Options([ConfigSetSub])
export class ConfigCommand extends Command {}

@Declare({ name: 'add', description: 'Add an item' })
@Group('items')
export class InventoryAddSub extends SubCommand {
	async run(ctx: CommandContext) {
		await ctx.write({ content: 'added' });
	}
}

@Declare({ name: 'inventory', description: 'Inventory command' })
@Groups({ items: { defaultDescription: 'Item management' } })
@Options([InventoryAddSub])
export class InventoryCommand extends Command {}

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

export const filterOptions = {
	count: createIntegerOption({ description: 'How many', required: true }),
	label: createStringOption({ description: 'Optional label' }),
};

@Declare({ name: 'filter', description: 'Filters by count' })
@Options(filterOptions)
export class FilterCommand extends Command {
	async run(ctx: CommandContext<typeof filterOptions>) {
		const count: number = ctx.options.count;
		const label: string | undefined = ctx.options.label;
		await ctx.write({ content: `${label ?? 'items'}:${count}` });
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
