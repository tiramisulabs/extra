import type { Client, OptionsRecord, UsingClient, WorkerClient } from 'seyfert';
import { type AvailableClients, Keys } from '../../things';
import { type WatcherCreateData, WatchersController, type YunaMessageWatcherControllerConfig } from './Controller';
import type { WatcherOptions } from './types';

type YunaMessageWatcherClient = (Client | WorkerClient | UsingClient) & {
	[Keys.clientWatcherController]?: WatchersController;
};

export const createController = ({ client, cache }: YunaMessageWatcherControllerConfig) => {
	const self = client as YunaMessageWatcherClient;
	return (self[Keys.clientWatcherController] ??= new WatchersController({ client, cache }));
};

export const getController = (client: AvailableClients) => {
	return (client as YunaMessageWatcherClient)[Keys.clientWatcherController];
};

export const createWatcher = <
	const O extends OptionsRecord | undefined = undefined,
	const C extends WatcherCreateData = WatcherCreateData,
>(
	ctx: C,
	options?: WatcherOptions,
) => {
	return createController({ client: ctx.client as Client | WorkerClient }).create<O, C>(ctx, options);
};
