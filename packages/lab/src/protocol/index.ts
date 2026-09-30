export const PROTOCOL_VERSION = 1;
export type { CommandSchema, PendingModal, VisibleConversation, VisibleMessage } from '@slipher/testing';

import type { Checkpoint } from '../index';

export type {
	ActionOutcome,
	Checkpoint,
	Expectation,
	InspectorSnapshot,
	LabAction,
	Preset,
	SessionDescription,
	SessionLog,
} from '../index';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface BuildInfo {
	revision: string;
	ref?: string;
	url?: string;
	builtAt?: string;
}
export type RunEndReason = 'expired' | 'max-lifetime' | 'restarted' | 'stopped' | 'shutdown';
export interface HostInfo {
	mode: 'local' | 'hosted';
	instanceId: string;
	labVersion: string;
	protocolVersion: number;
	build?: BuildInfo;
	limits?: { maxRuns: number; idleTtlMs: number; maxRunMs: number };
	run:
		| { state: 'none' }
		| { state: 'active'; session: boolean; startedAt?: string; idleExpiresAt?: string; expiresAt?: string }
		| { state: 'ended'; reason?: RunEndReason };
}
export type BridgeRequest =
	| { version: typeof PROTOCOL_VERSION; id: number; type: 'project.describe' }
	| { version: typeof PROTOCOL_VERSION; id: number; type: 'session.start'; payload: JsonValue }
	| {
			version: typeof PROTOCOL_VERSION;
			id: number;
			type: 'session.dispose' | 'session.log' | 'session.inspect' | 'session.describe' | 'session.commandSchemas';
	  }
	| {
			version: typeof PROTOCOL_VERSION;
			id: number;
			type: 'session.act' | 'session.view' | 'session.inspectProject';
			payload: JsonValue;
	  };
export type BridgeResponse = {
	version: typeof PROTOCOL_VERSION;
	id: number;
	type: 'result';
	ok: boolean;
	value?: JsonValue;
	error?: string;
};
export type BridgeEvent = { version: typeof PROTOCOL_VERSION; type: 'event'; event: JsonValue };
export type BridgeView = { actor: string; channelId: string; conversation: JsonValue };
export type BridgeInspector = { world: JsonValue; rest: JsonValue; pending: JsonValue; diagnostics: string[] };
export type BridgeLog = { preset: JsonValue; entries: JsonValue[] };
export interface ProjectDescription {
	name: string;
	scenarios: {
		id: string;
		version: number;
		title: string;
		params: Record<
			string,
			{
				kind: 'boolean' | 'string' | 'number' | 'enum';
				default: string | number | boolean;
				label?: string;
				values?: readonly (string | number | boolean)[];
			}
		>;
	}[];
	services: Record<string, { default: string; variants: string[] }>;
	inspectors: string[];
}
export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent;

const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(item => typeof item === 'string');
const stringMap = (value: unknown): boolean => record(value) && Object.values(value).every(string);
const params = (value: unknown): boolean =>
	record(value) &&
	Object.values(value).every(
		item =>
			typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
	);
function fail(label: string): never {
	throw new TypeError(`Invalid protocol ${label}`);
}
const requireString = (value: unknown, label: string): void => {
	if (!string(value)) fail(label);
};

export function validateHostInfo(value: unknown): asserts value is HostInfo {
	if (!record(value) || (value.mode !== 'local' && value.mode !== 'hosted')) fail('host info mode');
	requireString(value.instanceId, 'host info instanceId');
	requireString(value.labVersion, 'host info labVersion');
	if (!Number.isSafeInteger(value.protocolVersion)) fail('host info protocolVersion');
	if (value.build !== undefined) {
		if (!record(value.build)) fail('host info build');
		requireString(value.build.revision, 'host info build.revision');
		for (const key of ['ref', 'url', 'builtAt'])
			if (value.build[key] !== undefined) requireString(value.build[key], `host info build.${key}`);
	}
	if (value.mode === 'hosted') {
		if (!record(value.limits)) fail('host info limits');
		for (const key of ['maxRuns', 'idleTtlMs', 'maxRunMs'])
			if (!Number.isSafeInteger(value.limits[key]) || (value.limits[key] as number) <= 0)
				fail(`host info limits.${key}`);
	} else if (value.limits !== undefined) fail('host info local limits');
	if (!record(value.run)) fail('host info run');
	switch (value.run.state) {
		case 'none':
			return;
		case 'active':
			if (typeof value.run.session !== 'boolean') fail('host info session');
			for (const key of ['startedAt', 'idleExpiresAt', 'expiresAt'])
				if (value.run[key] !== undefined) requireString(value.run[key], `host info ${key}`);
			return;
		case 'ended':
			if (
				value.run.reason !== undefined &&
				!['expired', 'max-lifetime', 'restarted', 'stopped', 'shutdown'].includes(String(value.run.reason))
			)
				fail('host info reason');
			return;
		default:
			fail('host info run state');
	}
}

export function validateCheckpointName(value: unknown): asserts value is string {
	if (!string(value) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value))
		fail('checkpoint name: use 1-80 letters, numbers, _ or -');
}

const jsonValue = (value: unknown): boolean =>
	value === null ||
	typeof value === 'string' ||
	typeof value === 'boolean' ||
	(typeof value === 'number' && Number.isFinite(value)) ||
	(Array.isArray(value) && value.every(jsonValue)) ||
	(record(value) && Object.values(value).every(jsonValue));

export function validateCheckpoint(value: unknown, project?: ProjectDescription): asserts value is Checkpoint {
	if (!record(value)) fail('checkpoint: expected object');
	if (!jsonValue(value)) fail('checkpoint JSON data');
	if (value.version !== 1) fail(`checkpoint version: ${String(value.version)}`);
	requireString(value.labVersion, 'checkpoint labVersion');
	if (value.protocolVersion !== PROTOCOL_VERSION) fail(`checkpoint protocolVersion: ${String(value.protocolVersion)}`);
	validateCheckpointName(value.name);
	if (value.projectModule !== undefined) requireString(value.projectModule, 'checkpoint projectModule');
	if (value.build !== undefined) {
		if (!record(value.build)) fail('checkpoint build');
		requireString(value.build.revision, 'checkpoint build.revision');
	}
	validateBridgeRequest({ version: PROTOCOL_VERSION, id: 0, type: 'session.start', payload: value.preset });
	if (!Array.isArray(value.actions) || !Array.isArray(value.arrival)) fail('checkpoint actions/arrival');
	for (const action of value.actions) validateLabAction(action);
	if (value.outcomes !== undefined) {
		if (!Array.isArray(value.outcomes)) fail('checkpoint outcomes');
		for (const item of value.outcomes) {
			if (
				!record(item) ||
				!Number.isSafeInteger(item.action) ||
				(item.action as number) < 0 ||
				(item.action as number) >= value.actions.length ||
				typeof item.ok !== 'boolean'
			)
				fail('checkpoint outcome');
			if (item.error !== undefined && !string(item.error)) fail('checkpoint outcome error');
			if (item.error !== undefined)
				try {
					new RegExp(item.error as string);
				} catch {
					fail('checkpoint outcome error pattern');
				}
			if (
				item.dispatchCount !== undefined &&
				(!Number.isSafeInteger(item.dispatchCount) || (item.dispatchCount as number) < 0)
			)
				fail('checkpoint outcome dispatchCount');
		}
	}
	for (const item of value.arrival) {
		if (!record(item)) fail('checkpoint expectation');
		if ('view' in item) {
			if (
				!record(item.view) ||
				!string(item.view.actor) ||
				!string(item.view.channel) ||
				!string(item.contains) ||
				(item.absent !== undefined && typeof item.absent !== 'boolean')
			)
				fail('checkpoint view expectation');
		} else if ('role' in item) {
			if (
				!record(item.role) ||
				!string(item.role.guild) ||
				!string(item.role.member) ||
				!string(item.role.role) ||
				typeof item.present !== 'boolean'
			)
				fail('checkpoint role expectation');
		} else if ('project' in item) {
			if (
				!record(item.project) ||
				!string(item.project.name) ||
				typeof item.project.path !== 'string' ||
				(item.project.args !== undefined && !jsonValue(item.project.args)) ||
				!Object.hasOwn(item, 'equals') ||
				!jsonValue(item.equals)
			)
				fail('checkpoint project expectation');
		} else if ('action' in item) {
			if (
				!Number.isSafeInteger(item.action) ||
				(item.action as number) < 0 ||
				(item.action as number) >= value.actions.length ||
				typeof item.ok !== 'boolean' ||
				(item.error !== undefined && !string(item.error))
			)
				fail('checkpoint action expectation');
			if (item.error !== undefined)
				try {
					new RegExp(item.error as string);
				} catch {
					fail('checkpoint action error pattern');
				}
		} else if (typeof item.path !== 'string' || !Object.hasOwn(item, 'equals') || !jsonValue(item.equals))
			fail('checkpoint path expectation');
	}
	if (
		project &&
		!project.scenarios.some(
			scenario =>
				scenario.id === (value.preset as Checkpoint['preset']).scenario.id &&
				scenario.version === (value.preset as Checkpoint['preset']).scenario.version,
		)
	)
		fail(
			`checkpoint scenario: ${(value.preset as Checkpoint['preset']).scenario.id}@${(value.preset as Checkpoint['preset']).scenario.version} is not defined`,
		);
}

export function validateLabAction(value: unknown): void {
	if (!record(value)) fail('action: expected object');
	switch (value.kind) {
		case 'user':
			requireString(value.actor, 'action.actor');
			switch (value.verb) {
				case 'slash':
					requireString(value.command, 'action.command');
					if (value.channel !== undefined) requireString(value.channel, 'action.channel');
					if (value.group !== undefined) requireString(value.group, 'action.group');
					if (value.subcommand !== undefined) requireString(value.subcommand, 'action.subcommand');
					if (value.group !== undefined && value.subcommand === undefined) fail('action.subcommand');
					if (value.options !== undefined && !record(value.options) && !Array.isArray(value.options))
						fail('action.options');
					return;
				case 'click':
				case 'select':
					requireString(value.customId, 'action.customId');
					if (!record(value.source)) fail('action.source');
					requireString(value.source.channel, 'action.source.channel');
					for (const key of ['messageRef', 'customId', 'contains', 'author'])
						if (value.source[key] !== undefined) requireString(value.source[key], `action.source.${key}`);
					if (value.verb === 'select' && !strings(value.values)) fail('action.values');
					return;
				case 'submitModal':
					requireString(value.customId, 'action.customId');
					if (value.channel !== undefined) requireString(value.channel, 'action.channel');
					if (
						!record(value.fields) ||
						!Object.values(value.fields).every(item => typeof item === 'string' || strings(item))
					)
						fail('action.fields');
					return;
				default:
					fail(`action.verb: ${String(value.verb)}`);
			}
		case 'admin':
			if (value.op !== 'addRole' && value.op !== 'removeRole') fail(`action.op: ${String(value.op)}`);
			for (const key of ['guild', 'member', 'role']) requireString(value[key], `action.${key}`);
			return;
		case 'local':
			requireString(value.actor, 'action.actor');
			if (value.op === 'closeModal' || value.op === 'reopenModal') {
				requireString(value.customId, 'action.customId');
				return;
			}
			if (value.op === 'dismissMessage') {
				if (!record(value.source)) fail('action.source');
				requireString(value.source.channel, 'action.source.channel');
				for (const key of ['messageRef', 'customId', 'contains', 'author'])
					if (value.source[key] !== undefined) requireString(value.source[key], `action.source.${key}`);
				if (value.source.messageRef === undefined && value.source.contains === undefined) fail('action.source');
				return;
			}
			fail(`action.op: ${String(value.op)}`);
		default:
			fail(`action.kind: ${String(value.kind)}`);
	}
}

export function validateBridgeRequest(value: unknown): asserts value is BridgeRequest {
	if (!record(value)) fail('request: expected object');
	if (value.version !== PROTOCOL_VERSION) fail('version');
	if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) fail('id');
	switch (value.type) {
		case 'project.describe':
			return;
		case 'session.start':
			if (!record(value.payload) || !record(value.payload.scenario)) fail('session.start payload');
			requireString(value.payload.scenario.id, 'scenario.id');
			if (!Number.isSafeInteger(value.payload.scenario.version)) fail('scenario.version');
			if (value.payload.params !== undefined && !params(value.payload.params)) fail('session.start params');
			if (value.payload.services !== undefined && !stringMap(value.payload.services)) fail('session.start services');
			if (value.payload.refs !== undefined && !stringMap(value.payload.refs)) fail('session.start refs');
			return;
		case 'session.act':
			validateLabAction(value.payload);
			return;
		case 'session.view':
			if (!record(value.payload)) fail('session.view payload');
			requireString(value.payload.actor, 'session.view actor');
			requireString(value.payload.channelRef, 'session.view channelRef');
			return;
		case 'session.inspectProject':
			if (!record(value.payload)) fail('session.inspectProject payload');
			requireString(value.payload.name, 'session.inspectProject name');
			return;
		case 'session.dispose':
		case 'session.log':
		case 'session.inspect':
		case 'session.describe':
		case 'session.commandSchemas':
			return;
		default:
			fail(`request type: ${String(value.type)}`);
	}
}

export function validateProjectDescription(value: unknown): asserts value is ProjectDescription {
	if (
		!record(value) ||
		!string(value.name) ||
		!Array.isArray(value.scenarios) ||
		!record(value.services) ||
		!strings(value.inspectors)
	)
		fail('project description');
	for (const scenario of value.scenarios) {
		if (
			!record(scenario) ||
			!string(scenario.id) ||
			!Number.isSafeInteger(scenario.version) ||
			!string(scenario.title) ||
			!record(scenario.params)
		)
			fail('project scenario');
		for (const parameter of Object.values(scenario.params)) {
			if (
				!record(parameter) ||
				!['boolean', 'string', 'number', 'enum'].includes(String(parameter.kind)) ||
				!Object.hasOwn(parameter, 'default')
			)
				fail('project parameter');
			if (parameter.kind === 'boolean' && typeof parameter.default !== 'boolean') fail('project parameter default');
			if (parameter.kind === 'string' && typeof parameter.default !== 'string') fail('project parameter default');
			if (parameter.kind === 'number' && (typeof parameter.default !== 'number' || !Number.isFinite(parameter.default)))
				fail('project parameter default');
			if (parameter.kind === 'enum' && typeof parameter.default !== 'string') fail('project parameter default');
			if (parameter.label !== undefined && typeof parameter.label !== 'string') fail('project parameter label');
			if (
				parameter.kind === 'enum' &&
				(!strings(parameter.values) || !parameter.values.includes(parameter.default as string))
			)
				fail('project parameter values');
		}
	}
	for (const service of Object.values(value.services))
		if (
			!record(service) ||
			!string(service.default) ||
			!strings(service.variants) ||
			!service.variants.includes(service.default)
		)
			fail('project service');
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
	if (!record(value) || value.version !== PROTOCOL_VERSION || !string(value.type)) return false;
	if (value.type === 'event') {
		if (!record(value.event)) return false;
		const event = value.event;
		if (
			!['started', 'action', 'error', 'disposed', 'rest', 'dispatch', 'world', 'interaction'].includes(
				String(event.type),
			)
		)
			return false;
		if (event.type === 'rest' && event.phase !== 'request' && event.phase !== 'settled') return false;
		if (event.type === 'dispatch' && event.phase !== 'start' && event.phase !== 'end') return false;
		return event.type === 'started' || event.type === 'disposed' || Object.hasOwn(event, 'detail');
	}
	if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) return false;
	if (value.type === 'result')
		return (
			typeof value.ok === 'boolean' &&
			(value.ok ? Object.hasOwn(value, 'value') && value.error === undefined : typeof value.error === 'string')
		);
	try {
		validateBridgeRequest(value);
		return true;
	} catch {
		return false;
	}
}
