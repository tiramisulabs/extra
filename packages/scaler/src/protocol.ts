import { createHash, timingSafeEqual } from 'node:crypto';
import { isRecord, toError } from './internal';
import type { AllocationIdentity, HostDescriptor, ObservedWorker, RemoteWorkerLaunch, ShardTopology } from './types';

export const SCALER_PROTOCOL_VERSION = 1 as const;

interface Envelope<T extends string> {
	type: T;
	version: typeof SCALER_PROTOCOL_VERSION;
}

interface RequestEnvelope<T extends string> extends Envelope<T> {
	requestId: string;
}

interface WorkerEnvelope<T extends string> extends Envelope<T> {
	workerId: number;
	identity: AllocationIdentity;
}

export interface HelloMessage extends Envelope<'HELLO'> {
	host: HostDescriptor;
	workers: ObservedWorker[];
}

export interface HelloAckMessage extends Envelope<'HELLO_ACK'> {
	masterId: string;
}

export interface LaunchMessage extends RequestEnvelope<'LAUNCH'>, WorkerEnvelope<'LAUNCH'> {
	topology: ShardTopology;
	launch: RemoteWorkerLaunch;
}

export interface StopMessage extends RequestEnvelope<'STOP'>, WorkerEnvelope<'STOP'> {}

interface WorkerStatusBase extends WorkerEnvelope<'WORKER_STATUS'> {
	topology: ShardTopology;
}

export interface WorkerReadyMessage extends WorkerStatusBase {
	status: 'ready';
	restarted?: true;
}

export interface WorkerExitedMessage extends WorkerStatusBase {
	status: 'exited';
	code: number | null;
	signal: NodeJS.Signals | null;
	reason?: string;
}

export type WorkerStatusMessage = WorkerReadyMessage | WorkerExitedMessage;

export interface IdentifyRequestMessage
	extends RequestEnvelope<'IDENTIFY_REQUEST'>,
		WorkerEnvelope<'IDENTIFY_REQUEST'> {
	shardId: number;
	maxConcurrency: number;
}

export interface IdentifyGrantMessage extends RequestEnvelope<'IDENTIFY_GRANT'>, WorkerEnvelope<'IDENTIFY_GRANT'> {
	shardId: number;
}

export interface WorkerMessage extends WorkerEnvelope<'WORKER_MSG'> {
	body: unknown;
}

export interface ErrorMessage extends Envelope<'ERROR'> {
	code:
		| 'AUTHENTICATION_FAILED'
		| 'CAPACITY_EXCEEDED'
		| 'INVALID_MESSAGE'
		| 'STALE_HOST'
		| 'STALE_WORKER'
		| 'UNSUPPORTED_WORKER_MODE'
		| 'UNSUPPORTED_VERSION'
		| 'WORKER_FAILED';
	message: string;
	requestId?: string;
}

export type AgentToMasterMessage =
	| HelloMessage
	| WorkerStatusMessage
	| IdentifyRequestMessage
	| WorkerMessage
	| ErrorMessage;

export type MasterToAgentMessage =
	| HelloAckMessage
	| LaunchMessage
	| StopMessage
	| IdentifyGrantMessage
	| WorkerMessage
	| ErrorMessage;

export type ScalerProtocolMessage = AgentToMasterMessage | MasterToAgentMessage;

const MESSAGE_TYPES = new Set<ScalerProtocolMessage['type']>([
	'HELLO',
	'HELLO_ACK',
	'LAUNCH',
	'STOP',
	'WORKER_STATUS',
	'IDENTIFY_REQUEST',
	'IDENTIFY_GRANT',
	'WORKER_MSG',
	'ERROR',
]);

const ERROR_CODES = new Set<ErrorMessage['code']>([
	'AUTHENTICATION_FAILED',
	'CAPACITY_EXCEEDED',
	'INVALID_MESSAGE',
	'STALE_HOST',
	'STALE_WORKER',
	'UNSUPPORTED_WORKER_MODE',
	'UNSUPPORTED_VERSION',
	'WORKER_FAILED',
]);

export class ProtocolValidationError extends Error {
	constructor(
		message: string,
		readonly code: ErrorMessage['code'] = 'INVALID_MESSAGE',
	) {
		super(message);
		this.name = 'ProtocolValidationError';
	}
}

export function parseProtocolMessage(raw: string | Buffer): ScalerProtocolMessage {
	let value: unknown;
	try {
		value = JSON.parse(raw.toString());
	} catch (error) {
		throw new ProtocolValidationError(`Protocol payload is not valid JSON: ${toError(error).message}`);
	}
	return validateProtocolMessage(value);
}

export function stringifyProtocolMessage(message: ScalerProtocolMessage): string {
	validateProtocolMessage(message);
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(message);
	} catch (error) {
		throw new ProtocolValidationError(`Protocol payload is not JSON-serializable: ${toError(error).message}`);
	}
	if (encoded === undefined) throw new ProtocolValidationError('Protocol payload is not JSON-serializable');
	return encoded;
}

export function validateProtocolMessage(value: unknown): ScalerProtocolMessage {
	if (!isRecord(value)) throw invalid('Protocol messages must be objects');
	if (!isString(value.type) || !MESSAGE_TYPES.has(value.type as ScalerProtocolMessage['type'])) {
		throw invalid(`Unknown scaler protocol message type ${String(value.type)}`);
	}
	if (value.version !== SCALER_PROTOCOL_VERSION) {
		throw new ProtocolValidationError(
			`Unsupported scaler protocol version ${String(value.version)}`,
			'UNSUPPORTED_VERSION',
		);
	}

	switch (value.type) {
		case 'HELLO':
			assertHost(value.host);
			if (!Array.isArray(value.workers)) throw invalid('HELLO workers must be an array');
			for (const worker of value.workers) assertObservedWorker(worker);
			break;
		case 'HELLO_ACK':
			identifier(value.masterId, 'HELLO_ACK masterId');
			break;
		case 'LAUNCH':
			request(value);
			worker(value);
			assertTopology(value.topology);
			assertLaunch(value.launch);
			break;
		case 'STOP':
			request(value);
			worker(value);
			break;
		case 'WORKER_STATUS':
			worker(value);
			assertTopology(value.topology);
			if (value.status === 'ready') {
				if (value.restarted !== undefined && value.restarted !== true) {
					throw invalid('WORKER_STATUS restarted must be true when present');
				}
			} else if (value.status === 'exited') {
				if (value.code !== null && !Number.isSafeInteger(value.code)) {
					throw invalid('WORKER_STATUS code must be an integer or null');
				}
				if (value.signal !== null && !isString(value.signal)) {
					throw invalid('WORKER_STATUS signal must be a string or null');
				}
				if (value.reason !== undefined && !isString(value.reason)) {
					throw invalid('WORKER_STATUS reason must be a string');
				}
			} else {
				throw invalid(`Unknown worker status ${String(value.status)}`);
			}
			break;
		case 'IDENTIFY_REQUEST':
			request(value);
			worker(value);
			nonNegativeInteger(value.shardId, `${value.type} shardId`);
			positiveInteger(value.maxConcurrency, 'IDENTIFY_REQUEST maxConcurrency');
			break;
		case 'IDENTIFY_GRANT':
			request(value);
			worker(value);
			nonNegativeInteger(value.shardId, `${value.type} shardId`);
			break;
		case 'WORKER_MSG':
			worker(value);
			if (!Object.hasOwn(value, 'body')) throw invalid('WORKER_MSG body is required');
			break;
		case 'ERROR':
			if (!isString(value.code) || !ERROR_CODES.has(value.code as ErrorMessage['code'])) {
				throw invalid(`Unknown protocol error code ${String(value.code)}`);
			}
			identifier(value.message, 'ERROR message');
			if (value.requestId !== undefined) identifier(value.requestId, 'ERROR requestId');
			break;
	}
	return value as unknown as ScalerProtocolMessage;
}

export function authenticationTokensEqual(actual: string, expected: string) {
	const actualHash = createHash('sha256').update(actual).digest();
	const expectedHash = createHash('sha256').update(expected).digest();
	return timingSafeEqual(actualHash, expectedHash);
}

export function sameIdentity(left: AllocationIdentity, right: AllocationIdentity) {
	return left.slot === right.slot && left.token === right.token;
}

export function sameTopology(left: ShardTopology, right: ShardTopology) {
	return (
		left.shardStart === right.shardStart && left.shardEnd === right.shardEnd && left.totalShards === right.totalShards
	);
}

function request(value: Record<string, unknown>) {
	identifier(value.requestId, `${String(value.type)} requestId`);
}

function worker(value: Record<string, unknown>) {
	nonNegativeInteger(value.workerId, `${String(value.type)} workerId`);
	assertIdentity(value.identity);
}

function assertIdentity(value: unknown): asserts value is AllocationIdentity {
	if (!isRecord(value)) throw invalid('Worker identity must be an object');
	identifier(value.slot, 'Worker identity slot');
	identifier(value.token, 'Worker identity token');
}

function assertTopology(value: unknown): asserts value is ShardTopology {
	if (!isRecord(value)) throw invalid('Worker topology must be an object');
	nonNegativeInteger(value.shardStart, 'Worker topology shardStart');
	positiveInteger(value.shardEnd, 'Worker topology shardEnd');
	positiveInteger(value.totalShards, 'Worker topology totalShards');
	if ((value.shardStart as number) >= (value.shardEnd as number)) {
		throw invalid('Worker topology shardStart must be lower than shardEnd');
	}
	if ((value.shardEnd as number) > (value.totalShards as number)) {
		throw invalid('Worker topology shardEnd cannot exceed totalShards');
	}
}

function assertHost(value: unknown): asserts value is HostDescriptor {
	if (!isRecord(value)) throw invalid('HELLO host must be an object');
	identifier(value.hostId, 'Host hostId');
	identifier(value.bootId, 'Host bootId');
	positiveInteger(value.maxWorkers, 'Host maxWorkers');
}

function assertObservedWorker(value: unknown): asserts value is ObservedWorker {
	if (!isRecord(value)) throw invalid('Observed worker must be an object');
	nonNegativeInteger(value.workerId, 'Observed workerId');
	assertIdentity(value.identity);
	assertTopology(value.topology);
	if (typeof value.ready !== 'boolean') throw invalid('Observed worker ready must be a boolean');
}

function assertLaunch(value: unknown): asserts value is RemoteWorkerLaunch {
	if (!isRecord(value) || !isRecord(value.workerData)) throw invalid('LAUNCH launch.workerData must be an object');
	if (value.env !== undefined && !isRecord(value.env)) throw invalid('LAUNCH launch.env must be an object');
	const data = value.workerData;
	identifier(data.path, 'WorkerData path');
	identifier(data.token, 'WorkerData token');
	if (!Array.isArray(data.shards) || !data.shards.every(shard => Number.isSafeInteger(shard) && shard >= 0)) {
		throw invalid('WorkerData shards must be non-negative integers');
	}
	nonNegativeInteger(data.workerId, 'WorkerData workerId');
	positiveInteger(data.totalShards, 'WorkerData totalShards');
	positiveInteger(data.totalWorkers, 'WorkerData totalWorkers');
	if (!['clusters', 'threads', 'custom'].includes(String(data.mode))) throw invalid('WorkerData mode is invalid');
}

function identifier(value: unknown, name: string): asserts value is string {
	if (!isString(value)) throw invalid(`${name} must be a non-empty string`);
}

function positiveInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(`${name} must be a positive integer`);
}

function nonNegativeInteger(value: unknown, name: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${name} must be a non-negative integer`);
}

function isString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function invalid(message: string) {
	return new ProtocolValidationError(message);
}
