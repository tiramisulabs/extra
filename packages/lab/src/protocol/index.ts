export const PROTOCOL_VERSION = 1;
export type { CommandSchema, PendingModal, VisibleConversation, VisibleMessage } from '@slipher/testing';

import type {
	Checkpoint,
	Expectation,
	LabAction,
	Locator,
	ParamDefinition,
	Preset,
	SessionEvent,
	SessionLog,
} from '../index';

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
const RUN_END_REASONS = ['expired', 'max-lifetime', 'restarted', 'stopped', 'shutdown'] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];
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
type Envelope = { version: typeof PROTOCOL_VERSION; id: number };
export type BridgeRequest = Envelope &
	(
		| {
				type:
					| 'project.describe'
					| 'session.dispose'
					| 'session.log'
					| 'session.inspect'
					| 'session.describe'
					| 'session.commandSchemas';
		  }
		| { type: 'session.start'; payload: Preset }
		| { type: 'session.act'; payload: LabAction }
		| { type: 'session.view'; payload: { actor: string; channelRef: string } }
		| { type: 'session.inspectProject'; payload: { name: string; args?: JsonValue } }
	);
export type BridgeResponse = Envelope & { type: 'result'; ok: boolean; value?: JsonValue; error?: string };
export type BridgeEvent = { version: typeof PROTOCOL_VERSION; type: 'event'; event: SessionEvent };
export interface ProjectDescription {
	name: string;
	scenarios: {
		id: string;
		version: number;
		title: string;
		params: Record<string, ParamDefinition>;
	}[];
	services: Record<string, { default: string; variants: string[] }>;
	inspectors: string[];
}
export type BridgeMessage = BridgeRequest | BridgeResponse | BridgeEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
/** Protocol identifiers and labels are never empty. */
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(item => typeof item === 'string');
const isTextMap = (value: unknown): boolean => isRecord(value) && Object.values(value).every(isText);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isNonNegativeInteger(value) && value > 0;
const isOneOf = <T>(options: readonly T[], value: unknown): value is T => options.some(option => option === value);
const isActionIndex = (value: unknown, actionCount: number): boolean =>
	isNonNegativeInteger(value) && value < actionCount;
const isParams = (value: unknown): boolean =>
	isRecord(value) &&
	Object.values(value).every(item => typeof item === 'boolean' || typeof item === 'string' || isFiniteNumber(item));
const isJsonValue = (value: unknown): boolean =>
	value === null ||
	typeof value === 'string' ||
	typeof value === 'boolean' ||
	isFiniteNumber(value) ||
	(Array.isArray(value) && value.every(isJsonValue)) ||
	(isRecord(value) && Object.values(value).every(isJsonValue));
const PARAM_KINDS: readonly ParamDefinition['kind'][] = ['boolean', 'string', 'number', 'enum'];
const isParamKind = (value: unknown): value is ParamDefinition['kind'] => isOneOf(PARAM_KINDS, value);

/** Whether `value` is valid for a parameter of `kind`; enum values must be one of `values`. */
export function isParamValue(kind: ParamDefinition['kind'], value: unknown, values: readonly unknown[] = []): boolean {
	switch (kind) {
		case 'boolean':
			return typeof value === 'boolean';
		case 'string':
			return typeof value === 'string';
		case 'number':
			return isFiniteNumber(value);
		case 'enum':
			return values.includes(value);
	}
}

function fail(label: string): never {
	throw new TypeError(`Invalid protocol ${label}`);
}
function requireRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!isRecord(value)) fail(label);
}
function requireText(value: unknown, label: string): asserts value is string {
	if (!isText(value)) fail(label);
}
function optionalText(value: unknown, label: string): asserts value is string | undefined {
	if (value !== undefined) requireText(value, label);
}
/** Error expectations are regular expressions matched against the recorded error. */
function optionalPattern(value: unknown, label: string): void {
	if (value === undefined) return;
	requireText(value, label);
	try {
		new RegExp(value);
	} catch {
		fail(`${label} pattern`);
	}
}

export function validateHostInfo(value: unknown): asserts value is HostInfo {
	if (!isRecord(value) || (value.mode !== 'local' && value.mode !== 'hosted')) fail('host info mode');
	requireText(value.instanceId, 'host info instanceId');
	requireText(value.labVersion, 'host info labVersion');
	if (!Number.isSafeInteger(value.protocolVersion)) fail('host info protocolVersion');
	if (value.build !== undefined) {
		requireRecord(value.build, 'host info build');
		requireText(value.build.revision, 'host info build.revision');
		for (const key of ['ref', 'url', 'builtAt']) optionalText(value.build[key], `host info build.${key}`);
	}
	if (value.mode === 'hosted') {
		requireRecord(value.limits, 'host info limits');
		for (const key of ['maxRuns', 'idleTtlMs', 'maxRunMs'])
			if (!isPositiveInteger(value.limits[key])) fail(`host info limits.${key}`);
	} else if (value.limits !== undefined) fail('host info local limits');
	requireRecord(value.run, 'host info run');
	switch (value.run.state) {
		case 'none':
			return;
		case 'active':
			if (typeof value.run.session !== 'boolean') fail('host info session');
			for (const key of ['startedAt', 'idleExpiresAt', 'expiresAt']) optionalText(value.run[key], `host info ${key}`);
			return;
		case 'ended':
			if (value.run.reason !== undefined && !isOneOf(RUN_END_REASONS, value.run.reason)) fail('host info reason');
			return;
		default:
			fail('host info run state');
	}
}

export const isCheckpointName = (value: unknown): value is string =>
	isText(value) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
export function validateCheckpointName(value: unknown): asserts value is string {
	if (!isCheckpointName(value)) fail('checkpoint name: use 1-80 letters, numbers, _ or -');
}

export function validateCheckpoint(value: unknown, project?: ProjectDescription): asserts value is Checkpoint {
	requireRecord(value, 'checkpoint: expected object');
	if (!isJsonValue(value)) fail('checkpoint JSON data');
	if (value.version !== 1) fail(`checkpoint version: ${String(value.version)}`);
	requireText(value.labVersion, 'checkpoint labVersion');
	if (value.protocolVersion !== PROTOCOL_VERSION) fail(`checkpoint protocolVersion: ${String(value.protocolVersion)}`);
	validateCheckpointName(value.name);
	optionalText(value.projectModule, 'checkpoint projectModule');
	if (value.build !== undefined) {
		requireRecord(value.build, 'checkpoint build');
		requireText(value.build.revision, 'checkpoint build.revision');
	}
	const preset = value.preset;
	validatePreset(preset);
	const { actions, outcomes, arrival } = value;
	if (!Array.isArray(actions) || !Array.isArray(arrival)) fail('checkpoint actions/arrival');
	for (const action of actions) validateLabAction(action);
	if (outcomes !== undefined) {
		if (!Array.isArray(outcomes)) fail('checkpoint outcomes');
		for (const outcome of outcomes) validateExpectedOutcome(outcome, actions.length);
	}
	for (const expectation of arrival) validateExpectation(expectation, actions.length);
	const { id, version } = preset.scenario;
	if (project && !project.scenarios.some(scenario => scenario.id === id && scenario.version === version))
		fail(`checkpoint scenario: ${id}@${version} is not defined`);
}

function validateExpectedOutcome(value: unknown, actionCount: number): void {
	if (!isRecord(value) || !isActionIndex(value.action, actionCount) || typeof value.ok !== 'boolean')
		fail('checkpoint outcome');
	optionalPattern(value.error, 'checkpoint outcome error');
	if (value.dispatchCount !== undefined && !isNonNegativeInteger(value.dispatchCount))
		fail('checkpoint outcome dispatchCount');
}

function validateExpectation(value: unknown, actionCount: number): void {
	requireRecord(value, 'checkpoint expectation');
	if ('view' in value) {
		if (
			!isRecord(value.view) ||
			!isText(value.view.actor) ||
			!isText(value.view.channel) ||
			!isText(value.contains) ||
			(value.absent !== undefined && typeof value.absent !== 'boolean')
		)
			fail('checkpoint view expectation');
	} else if ('role' in value) {
		if (
			!isRecord(value.role) ||
			!isText(value.role.guild) ||
			!isText(value.role.member) ||
			!isText(value.role.role) ||
			typeof value.present !== 'boolean'
		)
			fail('checkpoint role expectation');
	} else if ('project' in value) {
		if (
			!isRecord(value.project) ||
			!isText(value.project.name) ||
			typeof value.project.path !== 'string' ||
			!Object.hasOwn(value, 'equals')
		)
			fail('checkpoint project expectation');
	} else if ('action' in value) {
		if (!isActionIndex(value.action, actionCount) || typeof value.ok !== 'boolean')
			fail('checkpoint action expectation');
		optionalPattern(value.error, 'checkpoint action error');
	} else if (typeof value.path !== 'string' || !Object.hasOwn(value, 'equals')) fail('checkpoint path expectation');
}

function validatePreset(value: unknown): asserts value is Preset {
	if (!isRecord(value) || !isRecord(value.scenario)) fail('session.start payload');
	requireText(value.scenario.id, 'scenario.id');
	if (!Number.isSafeInteger(value.scenario.version)) fail('scenario.version');
	if (value.params !== undefined && !isParams(value.params)) fail('session.start params');
	if (value.services !== undefined && !isTextMap(value.services)) fail('session.start services');
	if (value.refs !== undefined && !isTextMap(value.refs)) fail('session.start refs');
}

function validateLocator(value: unknown): asserts value is Locator {
	requireRecord(value, 'action.source');
	requireText(value.channel, 'action.source.channel');
	for (const key of ['messageRef', 'customId', 'contains', 'author']) optionalText(value[key], `action.source.${key}`);
}

export function validateLabAction(value: unknown): asserts value is LabAction {
	requireRecord(value, 'action: expected object');
	switch (value.kind) {
		case 'user':
			validateUserAction(value);
			return;
		case 'admin':
			if (value.op !== 'addRole' && value.op !== 'removeRole') fail(`action.op: ${String(value.op)}`);
			for (const key of ['guild', 'member', 'role']) requireText(value[key], `action.${key}`);
			return;
		case 'local':
			requireText(value.actor, 'action.actor');
			switch (value.op) {
				case 'closeModal':
				case 'reopenModal':
					requireText(value.customId, 'action.customId');
					return;
				case 'dismissMessage':
					validateLocator(value.source);
					if (value.source.messageRef === undefined && value.source.contains === undefined) fail('action.source');
					return;
				default:
					fail(`action.op: ${String(value.op)}`);
			}
		default:
			fail(`action.kind: ${String(value.kind)}`);
	}
}

function validateUserAction(value: Record<string, unknown>): void {
	requireText(value.actor, 'action.actor');
	switch (value.verb) {
		case 'slash':
			requireText(value.command, 'action.command');
			for (const key of ['channel', 'group', 'subcommand']) optionalText(value[key], `action.${key}`);
			if (value.group !== undefined && value.subcommand === undefined) fail('action.subcommand');
			if (value.options !== undefined && !isRecord(value.options) && !Array.isArray(value.options))
				fail('action.options');
			return;
		case 'click':
		case 'select':
			requireText(value.customId, 'action.customId');
			validateLocator(value.source);
			if (value.verb === 'select' && !isStringArray(value.values)) fail('action.values');
			return;
		case 'submitModal':
			requireText(value.customId, 'action.customId');
			optionalText(value.channel, 'action.channel');
			if (
				!isRecord(value.fields) ||
				!Object.values(value.fields).every(item => typeof item === 'string' || isStringArray(item))
			)
				fail('action.fields');
			return;
		default:
			fail(`action.verb: ${String(value.verb)}`);
	}
}

export function validateBridgeRequest(value: unknown): asserts value is BridgeRequest {
	requireRecord(value, 'request: expected object');
	if (value.version !== PROTOCOL_VERSION) fail('version');
	if (!isNonNegativeInteger(value.id)) fail('id');
	switch (value.type) {
		case 'project.describe':
		case 'session.dispose':
		case 'session.log':
		case 'session.inspect':
		case 'session.describe':
		case 'session.commandSchemas':
			return;
		case 'session.start':
			validatePreset(value.payload);
			return;
		case 'session.act':
			validateLabAction(value.payload);
			return;
		case 'session.view':
			requireRecord(value.payload, 'session.view payload');
			requireText(value.payload.actor, 'session.view actor');
			requireText(value.payload.channelRef, 'session.view channelRef');
			return;
		case 'session.inspectProject':
			requireRecord(value.payload, 'session.inspectProject payload');
			requireText(value.payload.name, 'session.inspectProject name');
			return;
		default:
			fail(`request type: ${String(value.type)}`);
	}
}

export function validateProjectDescription(value: unknown): asserts value is ProjectDescription {
	if (
		!isRecord(value) ||
		!isText(value.name) ||
		!Array.isArray(value.scenarios) ||
		!isRecord(value.services) ||
		!isStringArray(value.inspectors)
	)
		fail('project description');
	for (const scenario of value.scenarios) {
		if (
			!isRecord(scenario) ||
			!isText(scenario.id) ||
			!Number.isSafeInteger(scenario.version) ||
			!isText(scenario.title) ||
			!isRecord(scenario.params)
		)
			fail('project scenario');
		for (const parameter of Object.values(scenario.params)) validateParamDefinition(parameter);
	}
	for (const service of Object.values(value.services))
		if (
			!isRecord(service) ||
			!isText(service.default) ||
			!isStringArray(service.variants) ||
			!service.variants.includes(service.default)
		)
			fail('project service');
}

function validateParamDefinition(value: unknown): void {
	if (!isRecord(value) || !isParamKind(value.kind) || !Object.hasOwn(value, 'default')) fail('project parameter');
	if (value.label !== undefined && typeof value.label !== 'string') fail('project parameter label');
	if (value.kind !== 'enum') {
		if (!isParamValue(value.kind, value.default)) fail('project parameter default');
	} else if (!isStringArray(value.values) || !isParamValue('enum', value.default, value.values))
		fail('project parameter values');
}

const SESSION_EVENT_TYPES: readonly SessionEvent['type'][] = [
	'started',
	'action',
	'error',
	'disposed',
	'rest',
	'dispatch',
	'world',
	'interaction',
];
const EVENT_PHASES: Partial<Record<SessionEvent['type'], readonly string[]>> = {
	rest: ['request', 'settled'],
	dispatch: ['start', 'end'],
};

function isSessionEvent(value: unknown): boolean {
	if (!isRecord(value) || !isOneOf(SESSION_EVENT_TYPES, value.type)) return false;
	const phases = EVENT_PHASES[value.type];
	if (phases && !isOneOf(phases, value.phase)) return false;
	return value.type === 'started' || value.type === 'disposed' || Object.hasOwn(value, 'detail');
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
	if (!isRecord(value) || value.version !== PROTOCOL_VERSION || !isText(value.type)) return false;
	if (value.type === 'event') return isSessionEvent(value.event);
	if (!isNonNegativeInteger(value.id)) return false;
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

export function createCheckpoint(
	log: SessionLog,
	name: string,
	arrival: Expectation[] = [],
	projectModule?: string,
): Checkpoint {
	const checkpoint: Checkpoint = {
		version: 1,
		labVersion: log.labVersion,
		protocolVersion: log.protocolVersion,
		name,
		preset: log.preset,
		actions: log.entries.map(entry => entry.action),
		outcomes: log.entries.map((entry, action) => ({
			action,
			ok: entry.outcome.ok,
			...(entry.outcome.error ? { error: `^${escapeRegExp(entry.outcome.error)}$` } : {}),
			dispatchCount: entry.outcome.dispatchIds.length,
		})),
		arrival,
		...(projectModule ? { projectModule } : {}),
	};
	validateCheckpoint(checkpoint);
	return checkpoint;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
