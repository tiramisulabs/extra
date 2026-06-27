import type { LoggerLike, QueueLike, SchedulerLike } from '@slipher/types';
import { Command, type CommandContext, createStringOption, Declare, Options } from 'seyfert';
import {
	type ButtonView,
	type ContainerView,
	mockCommandContext,
	mockLogger,
	mockQueues,
	mockScheduler,
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
