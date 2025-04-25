import { execSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { watch } from 'chokidar';
import { ApiHandler, Logger, Router, ShardManager } from 'seyfert';
import { BaseClient, type InternalRuntimeConfig } from 'seyfert/lib/client/base';
import type { MakeRequired, PickPartial } from 'seyfert/lib/common';
import {
	GatewayDispatchEvents,
	type GatewayDispatchPayload,
	type GatewayReadyDispatch,
	type GatewaySendPayload,
} from 'seyfert/lib/types';
import type { ShardManagerDefaults, ShardManagerOptions } from 'seyfert/lib/websocket';

/**
 * Represents a watcher class that extends the ShardManager.
 */
export class Watcher extends ShardManager {
	worker?: import('node:worker_threads').Worker;
	logger = new Logger({
		name: '[Watcher]',
	});
	rest?: ApiHandler;
	private readyPacket?: GatewayReadyDispatch;

	declare options: MakeRequired<WatcherOptions, 'token' | 'info' | keyof typeof ShardManagerDefaults>;

	/**
	 * Initializes a new instance of the Watcher class.
	 * @param options The options for the watcher.
	 */
	constructor(options: WatcherOptions) {
		super({
			handlePayload() {
				//
			},
			token: '',
			intents: 0,
			info: {
				url: 'wss://gateway.discord.gg',
				session_start_limit: {
					max_concurrency: -1,
					remaining: -1,
					reset_after: -1,
					total: -1,
				},
				shards: -1,
			},
			...options,
		});
	}

	/**
	 * Resets the worker instance.
	 */
	resetWorker() {
		if (this.worker) {
			this.worker.terminate();
		}
		this.build();
		this.worker = new Worker(this.options.filePath, {
			argv: this.options.argv,
			workerData: {
				__USING_WATCHER__: true,
			},
		});
		this.worker!.on('message', (data: WatcherSendToShard) => {
			switch (data.type) {
				case 'SEND_TO_SHARD':
					this.send(data.shardId, data.payload);
					break;
			}
		});

		if (this.readyPacket) {
			this.worker?.postMessage({
				type: 'PAYLOAD',
				shardId: 0,
				payload: this.readyPacket,
			} satisfies WatcherPayload);
		}
	}

	/**
	 * Spawns shards for the watcher.
	 */
	async spawnShards() {
		const RC = await BaseClient.prototype.getRC<InternalRuntimeConfig>();
		this.options.token = RC.token;
		this.rest ??= new ApiHandler({
			baseUrl: 'api/v10',
			domain: 'https://discord.com',
			token: this.options.token,
		});
		this.options.intents = RC.intents;
		this.options.info = await new Router(this.rest!).createProxy().gateway.bot.get();
		this.options.totalShards = this.options.info.shards;

		this.resetWorker();

		const oldFn = this.options.handlePayload;
		this.options.handlePayload = (shardId, payload) => {
			this.worker?.postMessage({
				type: 'PAYLOAD',
				shardId,
				payload,
			} satisfies WatcherPayload);

			if (!this.readyPacket && payload.t === GatewayDispatchEvents.Ready) {
				this.readyPacket = payload;
				this.readyPacket.d.guilds = [];
			}

			return oldFn?.(shardId, payload);
		};
		this.connectQueue.concurrency = this.options.info.session_start_limit.max_concurrency;

		await super.spawnShards();

		const watcher = watch(this.options.srcPath, {}).on('ready', () => {
			this.logger.debug(`Watching ${this.options.srcPath}`);
			watcher.on('all', event => {
				this.logger.debug(`${event} event detected, building`);
				this.resetWorker();
			});
		});
	}

	/**
	 * Builds the watcher.
	 */
	protected build() {
		try {
			if (this.options.transpileCommand) execSync(`cd ${process.cwd()} && ${this.options.transpileCommand}`);
			this.logger.info('Builded');
		} catch (e: any) {
			this.logger.fatal('Build Error');
			if (e.stdout?.length) this.logger.error(e.stdout.toString());
			if (e.stderr?.length) this.logger.error(e.stderr.toString());
		}
	}
}

export interface WatcherOptions
	extends PickPartial<
		Omit<ShardManager['options'], 'handlePayload' | 'info' | 'token' | 'intents'>,
		| 'compress'
		| 'presence'
		| 'properties'
		| 'shardEnd'
		| 'shardStart'
		| 'spawnShardDelay'
		| 'totalShards'
		| 'url'
		| 'version'
	> {
	filePath: string;
	transpileCommand?: string;
	srcPath: string;
	argv?: string[];
	handlePayload?: ShardManagerOptions['handlePayload'];
	info?: ShardManagerOptions['info'];
	token?: ShardManagerOptions['token'];
	intents?: ShardManagerOptions['intents'];
}

export interface WatcherPayload {
	type: 'PAYLOAD';
	shardId: number;
	payload: GatewayDispatchPayload;
}

export interface WatcherSendToShard {
	type: 'SEND_TO_SHARD';
	shardId: number;
	payload: GatewaySendPayload;
}
