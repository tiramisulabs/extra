import type { LoggerLike, QueueLike, SchedulerLike } from '@slipher/types';
import { Command, type CommandContext, createStringOption, Declare, Options } from 'seyfert';
import {
	type ButtonView,
	type ContainerView,
	type DispatchResult,
	mockCommandContext,
	mockLogger,
	mockQueues,
	mockScheduler,
	type OutcomeCapturedError,
	type OutcomeDenial,
	type OutcomeResponse,
	outcome,
	rendered,
} from '../src';

declare function expectType<T>(value: T): void;

const logger = mockLogger();
expectType<LoggerLike>(logger);

const queues = mockQueues();
expectType<QueueLike>(queues.get('welcome'));

const scheduler = mockScheduler();
expectType<SchedulerLike>(scheduler);

const typedContext = mockCommandContext<{ reason: string; count: number }>({
	options: { reason: 'spam', count: 2 },
});
expectType<string>(typedContext.options.reason);
expectType<number>(typedContext.options.count);

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

const reader = rendered({ content: 'x' });
expectType<ButtonView>(reader.get.button('save'));
expectType<ButtonView | undefined>(reader.query.button('save'));
expectType<readonly ButtonView[]>(reader.all.button('save'));
expectType<ContainerView>(reader.get.component('container', { content: /settings/i }));

// @ts-expect-error — component kinds are closed over the supported reader map.
reader.get.component('not-real', {});
// @ts-expect-error — embeds do not have string shorthand; use { title } / { contains }.
reader.get.embed('Campaign');
// @ts-expect-error — query object misspellings are rejected for object literals.
reader.get.button({ customID: 'save' });

declare const result: DispatchResult;
const state = outcome(result);

expectType<OutcomeResponse>(state.get.response());
expectType<OutcomeResponse | undefined>(state.query.response());
expectType<readonly OutcomeResponse[]>(state.all.response());
expectType<OutcomeDenial>(state.get.denial());
expectType<OutcomeCapturedError>(state.get.error());

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
