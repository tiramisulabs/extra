import type { Client } from 'seyfert';
import {
	type BaseMessage,
	type Command,
	CommandContext,
	type LimitedCollection,
	type OptionsRecord,
	type SubCommand,
	type UsingClient,
	type WorkerClient,
} from 'seyfert';
import { GatewayDispatchEvents } from 'seyfert/lib/types/index.js';
import type { YunaCommandUsable } from '../../things.js';
import { MessageWatcherManager } from './Manager.js';
import type { WatcherOptions } from './types.js';
import type { WatcherContext } from './watcherUtils.js';

export function createId(message: string, channelId: string): string;
export function createId(message: BaseMessage): string;
export function createId(message: BaseMessage | string, channelId?: string): string {
	if (typeof message === 'string') return `${channelId}.${message}`;
	return `${message.channelId}.${message.id}`;
}

type WatchersManagersCacheAdapter =
	| Map<string, MessageWatcherManager>
	| LimitedCollection<string, MessageWatcherManager>;

export interface YunaMessageWatcherControllerConfig {
	client: UsingClient;
	cache?: WatchersManagersCacheAdapter;
}

type BaseFindWatcherQuery = {
	messageId?: string;
	channelId?: string;
	guildId?: string;
	userId?: string;
	command?: Command | SubCommand;
};

export type FindWatcherQuery = BaseFindWatcherQuery | ((watcher: MessageWatcherManager) => boolean);

type InferCommandCtx<C extends YunaCommandUsable> = C extends YunaCommandUsable
	? Parameters<NonNullable<C['run']>>[0]
	: never;
export type InferCommandOptionsFromCtx<C> = C extends CommandContext<infer R> ? R : never;

export type InferWatcherFromQuery<
	Query extends FindWatcherQuery,
	C = Query extends BaseFindWatcherQuery ? Query['command'] : null,
	O = C extends Command ? InferCommandOptionsFromCtx<InferCommandCtx<C>> : null,
> = O extends OptionsRecord
	? C extends Command
		? MessageWatcherManager<O, InferWatcherContext<C>, C>
		: MessageWatcherManager<O>
	: MessageWatcherManager<any>;

export type WatcherCreateData = Pick<CommandContext, 'client' | 'command' | 'message' | 'shardId'>;

export type InferWatcherContext<C extends YunaCommandUsable | undefined> = C extends YunaCommandUsable
	? Extract<Awaited<ReturnType<NonNullable<C['run']>>>, WatcherContext<any>> extends WatcherContext<infer V>
		? V
		: never
	: never;

export type InferWatcherManagerFromCtx<C, Command extends YunaCommandUsable> = MessageWatcherManager<
	InferCommandOptionsFromCtx<C>,
	InferWatcherContext<Command>,
	Command
>;

export class WatchersController {
	/** watchers managers cache */
	managers: WatchersManagersCacheAdapter = new Map<string, MessageWatcherManager>();

	responsesManagers: WatchersManagersCacheAdapter = new Map<string, MessageWatcherManager>();

	watching = false;

	client: UsingClient;

	constructor({ cache = new Map(), client }: YunaMessageWatcherControllerConfig) {
		this.client = client;
		this.managers = cache;
	}

	init() {
		if (this.watching) return;

		const { client } = this;

		this.watching = true;

		const cache = this.managers;

		const deleteBy = (data: { channelId: string } | { guildId: string }) => {
			const isChannel = 'channelId' in data;

			const id = isChannel ? data.channelId : data.guildId;
			const key = isChannel ? 'channelId' : 'guildId';
			const errorName = isChannel ? 'channelDelete' : 'guildDelete';

			for (const instancesData of cache.values()) {
				const watcher = (instancesData as Exclude<typeof instancesData, MessageWatcherManager>).value ?? instancesData;

				if (watcher.message[key] !== id) continue;
				watcher.stop(errorName);
			}
		};

		const get = (messageId: string, channelId: string) => {
			const id = createId(messageId, channelId);
			return cache.get(id);
		};

		const deleteByMessage = (messageId: string, channelId: string, reason: string) => {
			const id = createId(messageId, channelId);

			const inResponses = this.responsesManagers.get(id);
			if (inResponses) return inResponses.onResponseDeleteEvent({ id: messageId, channelId }, id);

			const watcher = cache.get(id);

			watcher?.stop(reason);
		};

		const self = this;

		client.collectors.create({
			event: 'RAW',
			filter: () => true,
			run({ t: event, d: data }) {
				if (self.managers.size === 0) return;

				switch (event) {
					case GatewayDispatchEvents.GuildDelete:
						deleteBy({ guildId: data.id });
						break;
					case GatewayDispatchEvents.ThreadDelete:
						deleteBy({ channelId: data.id });
						break;
					case GatewayDispatchEvents.ChannelDelete:
						deleteBy({ channelId: data.id });
						break;
					case GatewayDispatchEvents.MessageDeleteBulk:
						for (const id of data.ids) deleteByMessage(id, data.channel_id, 'MessageBulkDelete');
						break;
					case GatewayDispatchEvents.MessageDelete:
						deleteByMessage(data.id, data.channel_id, 'MessageDelete');
						break;
					case GatewayDispatchEvents.MessageUpdate: {
						get(data.id, data.channel_id)?.__handleUpdate(data);
						break;
					}
				}
			},
		});
	}

	create<const O extends OptionsRecord | undefined = undefined, const C extends WatcherCreateData = WatcherCreateData>(
		ctx: C,
		options?: WatcherOptions,
	) {
		const { message, command, client } = ctx;
		if (!message) throw new Error('CommandContext does not have a message');
		if (!command.options?.length) throw new Error('The command has no options to watch');

		const id = createId(message);

		const manager = this.managers.get(id);

		this.init();

		type OptionsType = O extends undefined ? (C extends CommandContext<infer R> ? R : {}) : O;

		if (!manager)
			this.managers.set(
				id,
				new MessageWatcherManager<OptionsType>(
					this,
					client as Client | WorkerClient,
					message,
					command,
					ctx.shardId,
					ctx instanceof CommandContext ? ctx : undefined,
				),
			);

		const watcher = (this.managers.get(id) as MessageWatcherManager<OptionsType>)?.watch(options);

		return watcher;
	}

	getWatcherFromContext<const Ctx extends CommandContext, const Command extends YunaCommandUsable>(
		{ message }: Ctx,
		_commandType?: Command,
	) {
		if (!message) return;
		const id = createId(message);
		return this.managers.get(id) as InferWatcherManagerFromCtx<Ctx, Command> | undefined;
	}

	#baseSearch(query: BaseFindWatcherQuery, watcher: MessageWatcherManager) {
		if (query.guildId && watcher.message.guildId !== query.guildId) return false;
		if (query.channelId && watcher.message.channelId !== query.channelId) return false;
		if (query.messageId && watcher.message.id !== query.messageId) return false;
		if (query.userId && watcher.message.author.id !== query.userId) return false;
		if (query.command && watcher.command !== query.command) return false;
		return true;
	}

	*#findWatchers<const Query extends FindWatcherQuery>(query: Query) {
		const searchFn =
			typeof query === 'function' ? (query as Extract<FindWatcherQuery, Function>) : this.#baseSearch.bind(this, query);

		for (const value of this.managers.values()) {
			const watcher = (value as Exclude<typeof value, MessageWatcherManager<any>>).value ?? value;

			if (!watcher || searchFn(watcher) === false) continue;

			yield watcher as InferWatcherFromQuery<Query>;
		}

		return;
	}

	findWatcher<Query extends FindWatcherQuery>(query: Query) {
		return this.#findWatchers(query).next().value as InferWatcherFromQuery<Query> | undefined;
	}

	findManyWatchers<Query extends FindWatcherQuery>(query: Query): InferWatcherFromQuery<Query>[] {
		return Array.from(this.#findWatchers(query));
	}
}
