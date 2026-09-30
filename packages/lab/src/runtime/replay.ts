import type {
	ActionOutcome,
	Checkpoint,
	Expectation,
	ExpectedOutcome,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	Project,
	Session,
	SessionLog,
} from '../index';
import { createCheckpoint, validateCheckpoint } from '../protocol';
import { assertLabVersion } from '../shared';
import { messageShows } from './messages';
import { createSession } from './session';

export interface ReplayResult {
	log: SessionLog;
	inspect: InspectorSnapshot;
}

export function replay<R>(project: Project<R>, checkpoint: Checkpoint): Promise<ReplayResult>;
export function replay<R>(project: Project<R>, log: SessionLog, expectations: Expectation[]): Promise<ReplayResult>;
export async function replay<R>(
	project: Project<R>,
	input: Checkpoint | SessionLog,
	expectations: Expectation[] = [],
): Promise<ReplayResult> {
	const checkpoint = 'entries' in input ? createCheckpoint(input, 'replay', expectations) : input;
	validateCheckpoint(checkpoint);
	const { id, version } = checkpoint.preset.scenario;
	if (!project.scenarios.some(item => item.id === id && item.version === version))
		throw new Error(`Checkpoint scenario ${id}@${version} is not defined`);
	return replaySession(createSession(project, checkpoint.preset), checkpoint);
}

/** Starts `session`, repeats the checkpoint actions, checks outcomes and arrival, and disposes the session. */
export async function replaySession(session: Session, checkpoint: Checkpoint): Promise<ReplayResult> {
	validateCheckpoint(checkpoint);
	assertLabVersion(checkpoint);
	await session.start();
	try {
		for (const index of checkpoint.actions.keys()) await replayAction(session, checkpoint, index);
		const inspect = await session.inspect();
		for (const expectation of checkpoint.arrival) await checkArrival(session, checkpoint.name, expectation, inspect);
		return { log: await session.log(), inspect };
	} finally {
		await session.dispose();
	}
}

async function replayAction(session: Session, checkpoint: Checkpoint, index: number): Promise<void> {
	const expected = checkpoint.outcomes?.find(item => item.action === index);
	const action = replayable(checkpoint, index, expected);
	let failure: unknown;
	try {
		await session.act(action);
	} catch (error) {
		failure = error;
	}
	const actual = (await session.log()).entries[index]?.outcome;
	if (!actual) throw new Error(`Checkpoint "${checkpoint.name}" did not record action ${index + 1}`);
	if (expected) compareOutcome(checkpoint.name, index, actual, expected);
	else if (failure) throw failure;
}

/** A recorded dismissal names a message ID from the original run; replay finds the message by its text instead. */
function replayable(checkpoint: Checkpoint, index: number, expected: ExpectedOutcome | undefined): LabAction {
	const action = checkpoint.actions[index];
	if (action.kind !== 'local' || action.op !== 'dismissMessage' || !action.source.messageRef || expected?.ok === false)
		return action;
	if (!action.source.contains)
		throw new Error(`Checkpoint "${checkpoint.name}" cannot replay dismiss ${index + 1} without visible text`);
	const { messageRef: _messageRef, ...source } = action.source;
	return { ...action, source };
}

async function checkArrival(
	session: Session,
	name: string,
	expectation: Expectation,
	inspect: InspectorSnapshot,
): Promise<void> {
	if ('action' in expectation) {
		const actual = (await session.log()).entries[expectation.action]?.outcome;
		if (!actual) throw new Error(`Checkpoint "${name}" has no action ${expectation.action + 1}`);
		compareOutcome(name, expectation.action, actual, expectation);
	} else if ('view' in expectation) {
		const { actor, channel } = expectation.view;
		const shown = (await session.view(actor, channel)).messages.some(message =>
			messageShows(message, expectation.contains),
		);
		if (shown === Boolean(expectation.absent))
			throw new Error(
				`Checkpoint "${name}" failed view ${actor}/${channel}: ${expectation.contains} ${shown ? 'is present' : 'is absent'}`,
			);
	} else if ('role' in expectation) await checkRole(session, name, expectation, inspect);
	else if ('project' in expectation) {
		const { name: inspector, args, path } = expectation.project;
		const actual = readPath(await session.inspectProject(inspector, args), path);
		compareValue(name, `project ${inspector} ${path}`, actual, expectation.equals);
	} else compareValue(name, expectation.path, readPath(inspect, expectation.path), expectation.equals);
}

/** The part of the world snapshot that role expectations read; `inspect()` serializes it as JSON. */
interface WorldRoles {
	roles: { id: string; guildId: string }[];
	members: { guildId: string; userId: string; roles: string[] }[];
}

async function checkRole(
	session: Session,
	name: string,
	expectation: Extract<Expectation, { role: unknown }>,
	inspect: InspectorSnapshot,
): Promise<void> {
	const { refs } = await session.describe();
	const { guild, member, role } = expectation.role;
	const [guildId, memberId, roleId] = [guild, member, role].map(ref => refs[ref] ?? ref);
	const world = inspect.world as unknown as WorldRoles;
	if (!world.roles.some(item => item.id === roleId && item.guildId === guildId))
		throw new Error(`Checkpoint "${name}" has no role ${role} in ${guild}`);
	const found = world.members.find(item => item.guildId === guildId && item.userId === memberId);
	if (!found) throw new Error(`Checkpoint "${name}" has no member ${member} in ${guild}`);
	const present = found.roles.includes(roleId);
	if (present !== expectation.present)
		throw new Error(
			`Checkpoint "${name}" failed role ${role} for ${member} in ${guild}: expected ${presence(expectation.present)}, got ${presence(present)}`,
		);
}

const presence = (present: boolean): string => (present ? 'present' : 'absent');

function compareValue(name: string, label: string, actual: unknown, equals: JsonValue): void {
	if (JSON.stringify(actual) !== JSON.stringify(equals))
		throw new Error(
			`Checkpoint "${name}" failed at ${label}: expected ${JSON.stringify(equals)}, got ${JSON.stringify(actual)}`,
		);
}

/** Reads a dot-separated path; an empty path is the whole value. */
function readPath(value: unknown, path: string): unknown {
	if (!path) return value;
	return path
		.split('.')
		.reduce<unknown>(
			(current, key) =>
				current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
			value,
		);
}

function compareOutcome(
	name: string,
	index: number,
	actual: ActionOutcome,
	expected: Pick<ExpectedOutcome, 'ok' | 'error' | 'dispatchCount'>,
): void {
	if (
		actual.ok !== expected.ok ||
		(expected.error !== undefined && !new RegExp(expected.error).test(actual.error ?? '')) ||
		(expected.dispatchCount !== undefined && actual.dispatchIds.length !== expected.dispatchCount)
	)
		throw new Error(
			`Checkpoint "${name}" failed action ${index + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
}
