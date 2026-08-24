// Seyfert 5.0.0 does not export its classic worker protocol types from the package root.
// These type-only deep imports keep the scaler's IPC contract checked against the installed version.
import type { SendHeartbeat } from 'seyfert/lib/websocket/discord/heartbeater';
import type {
	ACKHeartbeat,
	WorkerDisconnectedAllShardsResharding,
	WorkerReady,
	WorkerRequestConnect,
	WorkerSendResultPayload,
	WorkerShardsConnected,
	WorkerStart,
} from 'seyfert/lib/websocket/discord/worker';
import type {
	DisconnectAllShardsResharding,
	ManagerAllowConnect,
	ManagerSendBotReady,
	ManagerSpawnShards,
} from 'seyfert/lib/websocket/discord/workermanager';
import type {
	AgentAllowConnectPayload,
	AgentHeartbeatPayload,
	AgentSpawnShardsPayload,
	CLASSIC_INTERNAL_MESSAGE_TYPES,
} from '../src/agent';
import type { RunnerDisconnectAllShardsPayload } from '../src/runner';
import type { ScalerBotReadyPayload } from '../src/scaler';

type AssertAssignable<Expected, Actual extends Expected> = Actual;
type AssertTrue<Condition extends true> = Condition;

// Checking ManagerSpawnShards directly preserves its optional `properties` member. Applying a second
// Pick to Seyfert's intersection type makes that member required in TypeScript 6.
export type AgentSpawnShardsContract = AssertAssignable<ManagerSpawnShards, AgentSpawnShardsPayload>;

export type AgentAllowConnectContract = AssertAssignable<
	Omit<ManagerAllowConnect, 'presence'>,
	AgentAllowConnectPayload
>;
export type ManagerAllowConnectPresenceContract = AssertTrue<
	AgentAllowConnectPayload extends ManagerAllowConnect ? true : false
>;

export type AgentHeartbeatContract = AssertAssignable<SendHeartbeat, AgentHeartbeatPayload>;
export type AgentDisconnectAllShardsContract = AssertAssignable<
	DisconnectAllShardsResharding,
	RunnerDisconnectAllShardsPayload
>;
export type AgentBotReadyContract = AssertAssignable<ManagerSendBotReady, ScalerBotReadyPayload>;

export declare function contractWorkerStartFields(message: WorkerStart): {
	workerId: WorkerStart['workerId'];
};
export declare function contractWorkerRequestConnectFields(message: WorkerRequestConnect): {
	workerId: WorkerRequestConnect['workerId'];
	shardId: WorkerRequestConnect['shardId'];
};
export declare function contractWorkerReadyFields(message: WorkerReady): {
	workerId: WorkerReady['workerId'];
};
export declare function contractWorkerSendResultPayloadFields(message: WorkerSendResultPayload): {
	workerId: WorkerSendResultPayload['workerId'];
	nonce: WorkerSendResultPayload['nonce'];
};

type SeyfertClassicInternalMessage =
	| ACKHeartbeat
	| WorkerRequestConnect
	| WorkerDisconnectedAllShardsResharding
	| WorkerReady
	| WorkerShardsConnected
	| WorkerStart;

type SeyfertClassicInternalMessageType = SeyfertClassicInternalMessage['type'];
type ScalerClassicInternalMessageType = (typeof CLASSIC_INTERNAL_MESSAGE_TYPES)[number];

export type ClassicInternalMessagesContract = AssertAssignable<
	SeyfertClassicInternalMessageType,
	ScalerClassicInternalMessageType
>;
export type ClassicInternalMessagesExactContract = AssertAssignable<
	ScalerClassicInternalMessageType,
	SeyfertClassicInternalMessageType
>;
