import {
	Command,
	type CommandContext,
	ComponentCommand,
	type ComponentContext,
	createStringOption,
	Declare,
	type Guild,
	ModalCommand,
	type ModalContext,
	Options,
	SubCommand,
} from 'seyfert';
import {
	type ButtonView,
	type ContainerView,
	createMockBot,
	type DispatchResult,
	type GuildMemberView,
	type MessageView,
	type MockComponentContext,
	type MockModalContext,
	mockCommandContext,
	mockComponentContext,
	mockGuild,
	mockModalContext,
	type OutcomeCapturedError,
	type OutcomeDenial,
	type OutcomeResponse,
	outcome,
	type RegisteredCommand,
	type RegisteredCommandFound,
	type RoleView,
	rendered,
} from '../src';

declare function expectType<T>(value: T): void;

const typedContext = mockCommandContext<{ reason: string; count: number }>({
	options: { reason: 'spam', count: 2 },
});
expectType<string>(typedContext.options.reason);
expectType<number>(typedContext.options.count);

const typedGuild = mockGuild({ icon: 'guild-icon' });
expectType<string | null>(typedGuild.icon);
expectType<string | undefined>(typedGuild.iconURL({ extension: 'webp', size: 128 }));
expectType<Pick<Guild, 'icon' | 'iconURL'>>(typedGuild);
// @ts-expect-error — guild icon hashes are strings or null, matching seyfert's guild shape.
mockGuild({ icon: 123 });

// Class-first form: options are INFERRED from the command's `run(ctx: CommandContext<typeof options>)` annotation.
const banOptions = { reason: createStringOption({ description: 'why', required: true }) };
@Declare({ name: 'ban', description: 'bans a user' })
@Options(banOptions)
class BanTypeCommand extends Command {
	async run(ctx: CommandContext<typeof banOptions>) {
		expectType<string>(ctx.options.reason);
	}
}

const inferredContext = mockCommandContext(BanTypeCommand, { options: { reason: 'spam' } });
expectType<string>(inferredContext.options.reason);

// @ts-expect-error — an unknown option key is rejected (inference is real, not `Record<string, unknown>`).
mockCommandContext(BanTypeCommand, { options: { wrongKey: 1 } });
// @ts-expect-error — a wrong option value type is rejected.
mockCommandContext(BanTypeCommand, { options: { reason: 123 } });

const subOptions = { value: createStringOption({ description: 'value', required: true }) };
@Declare({ name: 'set', description: 'sets a value' })
@Options(subOptions)
class SetTypeSub extends SubCommand {
	async run(ctx: CommandContext<typeof subOptions>) {
		expectType<string>(ctx.options.value);
	}
}

@Declare({ name: 'config', description: 'configures things' })
@Options([SetTypeSub])
class ConfigTypeCommand extends Command {}

createMockBot({ commands: [ConfigTypeCommand, SetTypeSub] });

class FilterTypeButton extends ComponentCommand {
	componentType = 'Button' as const;
	filter(ctx: ComponentContext<'Button'>) {
		expectType<string>(ctx.customId);
		return true;
	}
	async run(ctx: ComponentContext<'Button'>) {
		expectType<string>(ctx.customId);
	}
}

class FilterTypeSelect extends ComponentCommand {
	componentType = 'StringSelect' as const;
	filter(ctx: ComponentContext<'StringSelect'>) {
		expectType<string[]>(ctx.interaction.values);
		return true;
	}
	async run(ctx: ComponentContext<'StringSelect'>) {
		expectType<string[]>(ctx.interaction.values);
	}
}

class FilterTypeModal extends ModalCommand {
	filter(ctx: ModalContext) {
		expectType<string>(ctx.customId);
		return true;
	}
	async run(ctx: ModalContext) {
		expectType<string>(ctx.customId);
	}
}

const buttonFilter = mockComponentContext(FilterTypeButton);
expectType<Promise<boolean>>(buttonFilter.filter({ customId: 'save' }));
expectType<Promise<MockComponentContext<'Button'>>>(buttonFilter.run({ customId: 'save' }));
buttonFilter.filter(mockComponentContext({ customId: 'save' }));

const selectFilter = mockComponentContext(FilterTypeSelect);
expectType<Promise<boolean>>(
	selectFilter.filter({
		customId: 'pick',
		values: ['a'],
	}),
);
expectType<Promise<MockComponentContext<'StringSelect'>>>(
	selectFilter.run({
		customId: 'pick',
		values: ['a'],
	}),
);

const selectRunContext = mockComponentContext({
	customId: 'pick',
	componentType: 'StringSelect',
	values: ['a'],
});
expectType<'StringSelect'>(selectRunContext.componentType);
expectType<string[]>(selectRunContext.interaction.values);
selectFilter.filter(selectRunContext);

const objectSelectContext = mockComponentContext({ componentType: 'StringSelect', values: ['a'] });
expectType<'StringSelect'>(objectSelectContext.componentType);
expectType<string[]>(objectSelectContext.interaction.values);

const modalFilter = mockModalContext(FilterTypeModal);
expectType<Promise<boolean>>(modalFilter.filter({ customId: 'profile' }));
expectType<Promise<MockModalContext>>(modalFilter.run({ customId: 'profile' }));

// @ts-expect-error — class-first component harness cannot receive another component type.
buttonFilter.filter({ componentType: 'StringSelect' });
// @ts-expect-error — class-first component options moved to filter()/run().
mockComponentContext(FilterTypeButton, { customId: 'save' });

declare const bot: Awaited<ReturnType<typeof createMockBot>>;
bot.slash(SetTypeSub, { options: { value: 'x' } });
// @ts-expect-error — subcommand class dispatch keeps the inferred option value type.
bot.slash(SetTypeSub, { options: { value: 123 } });

const reader = rendered({ content: 'x' });
expectType<ButtonView>(reader.get.button('save'));
expectType<ButtonView | undefined>(reader.query.button('save'));
expectType<readonly ButtonView[]>(reader.all.button('save'));
expectType<ContainerView>(reader.get.component('container', { content: /settings/i }));

// @ts-expect-error — REST inspection belongs to bot/actor.restCalls() or result.actions.
void reader.raw.actions;
// @ts-expect-error — component kinds are closed over the supported reader map.
reader.get.component('not-real', {});
// @ts-expect-error — embeds do not have string shorthand; use { title } / { contains }.
reader.get.embed('Campaign');
// @ts-expect-error — query object misspellings are rejected for object literals.
reader.get.button({ customID: 'save' });

declare const result: DispatchResult;
// @ts-expect-error DispatchResult snapshots are data only; lookup belongs to rendered(result).
result.component('save');
// @ts-expect-error Snapshot components cannot dispatch actions; use bot.clickButton().
result.components[0]?.click();
// @ts-expect-error Snapshot components cannot dispatch actions; use bot.selectMenu().
result.components[0]?.select(['x']);
const state = outcome(result);

expectType<OutcomeResponse>(state.get.response());
expectType<OutcomeResponse | undefined>(state.query.response());
expectType<readonly OutcomeResponse[]>(state.all.response());
expectType<OutcomeDenial>(state.get.denial());
expectType<OutcomeCapturedError>(state.get.error());

declare const registeredCommand: RegisteredCommand;
expectType<string | undefined>(registeredCommand.path);
expectType<boolean>(registeredCommand.loaded);
expectType<readonly RegisteredCommandFound[]>(registeredCommand.found);

const response = state.get.response();
response.events;

const maybeResponse = state.query.response();
if (maybeResponse) maybeResponse.deferred;

const responses = state.all.response();
responses.map(item => item.kind);

const denial = state.get.denial();
denial.denialKind;

const captured = state.get.error();
captured.error;

outcome(result).get.response({ kind: 'modal' });
outcome(result).get.response({ ephemeral: true });
outcome(result).get.denial({ kind: 'permissions', missing: ['BanMembers'] as const });
outcome(result).get.error(/timeout/i);
outcome(result).get.error(error => error instanceof Error);
outcome(result).get.error({ match: error => error instanceof Error });

// @ts-expect-error - unknown response query keys are rejected.
outcome(result).get.response({ deferredReply: true });

// @ts-expect-error - response kinds are closed.
outcome(result).get.response({ kind: 'deferred' });

// @ts-expect-error - unknown denial query keys are rejected.
outcome(result).get.denial({ permission: 'BanMembers' });

// @ts-expect-error - denial kinds are closed over DispatchDenial["kind"].
outcome(result).get.denial({ kind: 'permission' });

// @ts-expect-error - unknown error query keys are rejected.
outcome(result).get.error({ message: /timeout/i });

expectType<MessageView>(bot.world.get.message({ channelId: 'c', id: 'm' }));
expectType<MessageView | undefined>(bot.world.query.message({ id: 'm' }));
expectType<MessageView[]>(bot.world.all.message({ channelId: 'c' }));
expectType<GuildMemberView>(bot.world.get.member({ guildId: 'g', userId: 'u' }));
expectType<RoleView | undefined>(bot.world.query.role({ id: 'r' }));
expectType<string | undefined>(bot.world.query.rawMessage({ channelId: 'c', id: 'm' })?.content);

// @ts-expect-error - world queries require at least one known key.
bot.world.get.channel({});

// @ts-expect-error - unknown world query keys are rejected.
bot.world.get.channel({ channelID: 'c' });

// @ts-expect-error - member query uses userId, not memberId.
bot.world.query.member({ guildId: 'g', memberId: 'u' });
