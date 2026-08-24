import type { RESTGetAPIGatewayBotResult, WorkerData } from 'seyfert';

type Awaitable<T> = T | PromiseLike<T>;

export interface AllocationIdentity {
	/** Stable for one logical allocation, including local respawns. */
	slot: string;
	/** Fresh for every physical process. */
	token: string;
}

export interface ShardTopology {
	shardStart: number;
	/** Exclusive shard boundary. */
	shardEnd: number;
	totalShards: number;
}

export interface HostDescriptor {
	hostId: string;
	bootId: string;
	maxWorkers: number;
}

export interface PlacementLocation {
	hostId: string;
	bootId: string;
}

export interface ObservedWorker {
	workerId: number;
	identity: AllocationIdentity;
	topology: ShardTopology;
	ready: boolean;
}

export interface LogicalWorker extends ShardTopology {
	workerId: number;
}

export type PlacementStrategy = 'spread' | 'fill-first';

export interface ConnectedScalerHost {
	descriptor: HostDescriptor;
	connectedAt: number;
	lastSeenAt: number;
	observed: readonly ObservedWorker[];
}

export interface RemoteWorkerLaunch {
	workerData: WorkerData;
	env?: Readonly<Record<string, unknown>>;
}

export interface ResolvedShardTopology extends ShardTopology {
	info: RESTGetAPIGatewayBotResult;
	shardsPerWorker: number;
	workers: number;
}

export interface ScalerMasterPort {
	readonly hosts: ReadonlyMap<string, ConnectedScalerHost>;
	listen(): Promise<unknown>;
	close(): Promise<void>;
	launch(
		target: PlacementLocation,
		workerId: number,
		identity: AllocationIdentity,
		topology: ShardTopology,
		launch: RemoteWorkerLaunch,
	): Promise<void>;
	stop(target: PlacementLocation, workerId: number, identity: AllocationIdentity): Promise<void>;
	postMessage(target: PlacementLocation, workerId: number, identity: AllocationIdentity, body: unknown): Promise<void>;
	on(event: string, listener: (...args: any[]) => void): unknown;
	off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface LogicalWorkerResolver {
	resolveLogicalWorkers(signal: AbortSignal): Awaitable<readonly LogicalWorker[]>;
}

export interface SeyfertScalerOptions {
	master: ScalerMasterPort;
	workers: readonly LogicalWorker[] | LogicalWorkerResolver;
	placementStrategy?: PlacementStrategy;
	createLaunch(input: {
		worker: Readonly<LogicalWorker>;
		target: Readonly<PlacementLocation>;
		identity: Readonly<AllocationIdentity>;
		signal: AbortSignal;
	}): Awaitable<RemoteWorkerLaunch>;
	readinessTimeoutMs?: number;
	startupTimeoutMs?: number;
	/**
	 * Re-place workers after a host becomes unreachable. Disabled by default:
	 * liveness cannot distinguish a dead host from a network partition, so this
	 * opt-in may overlap two physical workers for the same logical worker.
	 */
	autoRePlaceOnHostLoss?: boolean;
}

export type SeyfertScalerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
