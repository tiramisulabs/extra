import type { Command, CommandContext, Message, OnOptionsReturnObject, OptionsRecord, SubCommand } from 'seyfert';
import type { Awaitable, MakeRequired } from 'seyfert/lib/common';
import type { GatewayMessageUpdateDispatchData } from 'seyfert/lib/types';
import type { YunaCommandUsable } from '../../things';
import type { InferWatcherContext } from './Controller';
import type { MessageWatcherManager } from './Manager';
import type { MessageWatcher } from './Watcher';

export type WatcherOptions = {
	idle?: number;
	time?: number;
};

type RawMessageUpdated = MakeRequired<GatewayMessageUpdateDispatchData, 'content'>;

export type WatcherOnChangeEvent<M extends MessageWatcher, O extends OptionsRecord> = (
	this: M,
	ctx: CommandContext<O>,
	rawMessage: RawMessageUpdated,
) => any;

export type WatcherOnResponseDelete<M extends MessageWatcher> = (
	this: M,
	message: Pick<Message, 'id' | 'channelId'>,
) => any;
export type WatcherOnStopEvent<M extends MessageWatcher> = (this: M, reason: string) => any;
export type WatcherOnOptionsErrorEvent<M extends MessageWatcher> = (this: M, data: OnOptionsReturnObject) => any;

interface WatcherUsageErrorEvents {
	UnspecifiedPrefix: [];

	CommandChanged: [newCommand: Command | SubCommand | undefined];
}

export type WatcherOnUsageErrorEvent<M extends MessageWatcher> = <E extends keyof WatcherUsageErrorEvents>(
	this: M,
	reason: E,
	...params: WatcherUsageErrorEvents[E]
) => any;

export interface DecoratorWatchOptions<
	C extends YunaCommandUsable,
	O extends OptionsRecord,
	Context,
	M extends MessageWatcher<O, Context, C> = MessageWatcher<O, Context, C>,
> extends WatcherOptions {
	/**
	 * It will be emitted before creating the watcher,
	 * if you return `false` it will not be created.
	 */
	beforeCreate?(this: C, ctx: CommandContext<O>): Awaitable<boolean> | void;
	/** filters the execution of the `onChange` event */
	filter?(...args: Parameters<WatcherOnChangeEvent<MessageWatcher<O>, O>>): boolean;
	onStop?: WatcherOnStopEvent<M>;
	/** set this event will override the default onChange, and NOT execute command run if you not do it manually,
	 *  and Watcher.context or Watcher.stop not work if you not return it.  */
	onChange?: WatcherOnChangeEvent<M, O>;
	onUsageError?: WatcherOnUsageErrorEvent<M>;
	onOptionsError?: WatcherOnOptionsErrorEvent<M>;
	onResponseDelete?: WatcherOnResponseDelete<M>;
}

export type InferCommandOptions<C extends YunaCommandUsable> = Parameters<
	NonNullable<C['run']>
>[0] extends CommandContext<infer O>
	? O
	: never;

export type InferWatcher<C extends YunaCommandUsable> = MessageWatcher<
	InferCommandOptions<C>,
	InferWatcherContext<C>,
	C
>;

export type InferWatcherManager<C extends YunaCommandUsable> = MessageWatcherManager<
	InferCommandOptions<C>,
	InferWatcherContext<C>,
	C
>;
