import {
	type Actor,
	apiUser,
	createMockBot,
	type MockBot,
	type MockBotEvent,
	mockWorld,
	type WorldBuilder,
} from '@slipher/testing';
import type {
	ActionOutcome,
	ActorSpec,
	LabAction,
	Params,
	Preset,
	Project,
	Ref,
	Scenario,
	ScenarioWorld,
	Session,
	SessionEvent,
	SessionLog,
} from '../index';
import { isParamValue, PROTOCOL_VERSION, validateLabAction } from '../protocol';
import { createObservers, errorText } from '../shared';
import { performAction } from './actions';
import { jsonCopy, toJson } from './json';
import { conversation, describeRun, inspectRun, type Run, requireActor, resolveRef, unknownRefError } from './run';

export const LAB_VERSION: string = require('../../package.json').version;

const DEFAULT_DISPOSE_TIMEOUT_MS = 5000;

export function deterministicId(name: string): string {
	// FNV-1a 64-bit, masked to 62 bits so the ID stays a positive snowflake-sized decimal.
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(name)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
	return (hash & 0x3fffffffffffffffn).toString();
}

/** Cleanup for what a start has acquired so far. */
interface Acquired {
	stopObserving?: () => void;
	closeBot?: () => Promise<void>;
	disposeResources?: () => void | Promise<void>;
}

type SessionState<R> =
	| { status: 'idle' }
	| { status: 'starting'; task: Promise<void> }
	| { status: 'active'; run: Run<R>; acquired: Acquired }
	| { status: 'stopping' };

export function createSession<R>(
	project: Project<R>,
	preset: Preset,
	options: { disposeTimeoutMs?: number } = {},
): Session {
	const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
	const observers = createObservers();
	const { emit } = observers;
	let state: SessionState<R> = { status: 'idle' };
	let stopTask: Promise<void> | undefined;
	let log = newLog(preset);

	const requireRun = (): Run<R> => {
		if (state.status !== 'active') throw new Error('Session is not started');
		return state.run;
	};

	/** Stops observing, closes the bot, then disposes resources; every step runs even if an earlier one fails. */
	const release = async (acquired: Acquired): Promise<void> => {
		const failures: unknown[] = [];
		const attempt = async (step: (() => void | Promise<void>) | undefined, label: string) => {
			if (!step) return;
			try {
				await deadline(Promise.resolve(step()), disposeTimeoutMs, label);
			} catch (error) {
				failures.push(error);
			}
		};
		acquired.stopObserving?.();
		await attempt(acquired.closeBot, 'bot close');
		await attempt(acquired.disposeResources, 'resources dispose');
		state = { status: 'idle' };
		emit({ type: 'disposed' });
		if (failures.length)
			throw new AggregateError(failures, `Session cleanup failed: ${failures.map(errorText).join('; ')}`);
	};

	const startRun = async (): Promise<void> => {
		const acquired: Acquired = {};
		try {
			const run = await bootRun(project, preset, acquired, event => emit(sessionEventOf(event)));
			const { params, services } = run.context;
			log.preset = { scenario: { ...preset.scenario }, params, services, refs: { ...run.refs } };
			state = { status: 'active', run, acquired };
			emit({ type: 'started' });
		} catch (error) {
			emit({ type: 'error', detail: errorText(error) });
			try {
				await release(acquired);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Session start and cleanup failed');
			}
			throw error;
		}
	};

	const stop = async (): Promise<void> => {
		// A failed start has already released what it acquired.
		if (state.status === 'starting') await state.task.catch(() => {});
		if (state.status !== 'active') return;
		const { acquired } = state;
		state = { status: 'stopping' };
		await release(acquired);
	};

	const record = (action: LabAction, outcome: ActionOutcome) => {
		log.entries.push({ seq: log.entries.length + 1, action: jsonCopy(action), outcome });
		emit({ type: 'action', detail: toJson(outcome) });
	};

	const session: Session = {
		start() {
			if (state.status !== 'idle') return Promise.reject(new Error(`Session is ${state.status}; cannot start`));
			// Deferred one microtask so the state holds the task before any start code can observe it.
			const task = Promise.resolve().then(startRun);
			state = { status: 'starting', task };
			return task;
		},
		dispose() {
			stopTask ??= stop().finally(() => {
				stopTask = undefined;
			});
			return stopTask;
		},
		async reset() {
			await session.dispose();
			log = newLog(preset);
			await session.start();
		},
		async act(action) {
			const run = requireRun();
			try {
				validateLabAction(action);
				const result = await performAction(run, action);
				const outcome: ActionOutcome = {
					ok: true,
					dispatchIds: [
						...new Set(
							result.dispatch?.actions.flatMap(entry => (entry.dispatchId === undefined ? [] : [entry.dispatchId])),
						),
					],
					summary: result.summary ?? result.dispatch?.content ?? result.dispatch?.modal?.title ?? 'completed',
				};
				record(result.recorded ?? action, outcome);
				return outcome;
			} catch (error) {
				const message = errorText(error);
				record(action, { ok: false, error: message, dispatchIds: [], summary: 'failed' });
				emit({ type: 'error', detail: message });
				throw new Error(message);
			}
		},
		observe: observers.observe,
		async view(actor, channelRef) {
			const run = requireRun();
			return conversation(run, requireActor(run, actor), resolveRef(run, channelRef));
		},
		async inspect() {
			return inspectRun(requireRun(), observers.diagnostics);
		},
		async describe() {
			return describeRun(requireRun(), log.preset);
		},
		async commandSchemas() {
			return requireRun().bot.commandSchemas();
		},
		async inspectProject(name, args = null) {
			const run = requireRun();
			const handler = project.inspect?.[name];
			if (!handler) throw new Error(`Unknown project inspector "${name}"`);
			return toJson(await handler(run.context, args));
		},
		async log() {
			return jsonCopy(log);
		},
	};
	return session;
}

function newLog(preset: Preset): SessionLog {
	return { labVersion: LAB_VERSION, protocolVersion: PROTOCOL_VERSION, preset: jsonCopy(preset), entries: [] };
}

async function deadline(task: Promise<void>, ms: number, label: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			task,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${ms}ms; external cleanup may be pending`)),
					ms,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Builds the world, starts the bot and seeds the scenario. Everything that needs cleanup is recorded in
 * `acquired` as soon as it exists, so a failure at any step can release it.
 */
async function bootRun<R>(
	project: Project<R>,
	preset: Preset,
	acquired: Acquired,
	onBotEvent: (event: MockBotEvent) => void,
): Promise<Run<R>> {
	const scenario = findScenario(project, preset);
	const params = scenarioParams(scenario, preset);
	const services = selectedServices(project, preset);
	await project.configure?.();
	const resources = await setupResources(project, preset, acquired);

	const refs: Record<string, string> = Object.create(null);
	const builder = mockWorld();
	const ref = createRef(project, preset, refs);
	scenario.world?.(scenarioWorld(builder, ref, refs), { params, ref });
	for (const name of Object.keys(preset.refs ?? {}))
		if (!refs[name]) throw new Error(`Preset overrides unknown ref "${name}"`);

	// A project may return a ready MockBot (to keep a handle on it) or the options to create one.
	const provided = (await project.bot?.({ world: builder, resources })) ?? { loadFromConfig: true };
	const bot = 'actor' in provided ? provided : await createMockBot({ ...provided, world: builder });
	acquired.closeBot = () => bot.close();
	acquired.stopObserving = bot.observe(onBotEvent);

	const context = { params, refs: { ...refs }, resources, services };
	for (const [name, service] of Object.entries(project.services ?? {})) await service.variants[services[name]](context);
	const missing = (await scenario.requires?.(context)) ?? [];
	if (missing.length) throw new Error(`Missing requirements: ${missing.join(', ')}`);
	await scenario.seed?.(context);

	const actors = new Map(
		Object.entries(scenario.actors?.(context.refs) ?? {}).map(([key, spec]) => [
			key,
			{ key, spec, handle: createActor(bot, builder, refs, key, spec) },
		]),
	);
	return { bot, refs, actors, context, closedModals: new Set(), dismissed: new Map() };
}

function findScenario<R>(project: Project<R>, preset: Preset): Scenario<R> {
	const { id, version } = preset.scenario;
	const found = project.scenarios.find(item => item.id === id && item.version === version);
	if (!found) throw new Error(`Scenario ${id}@${version} is not defined`);
	return found;
}

function scenarioParams<R>(scenario: Scenario<R>, preset: Preset): Params {
	const definitions = scenario.params ?? {};
	const given = preset.params ?? {};
	const params: Params = {};
	for (const [name, definition] of Object.entries(definitions)) {
		const value = Object.hasOwn(given, name) ? given[name] : definition.default;
		if (!isParamValue(definition.kind, value, definition.values))
			throw new TypeError(`Invalid parameter "${name}": expected ${definition.kind}`);
		params[name] = value;
	}
	for (const name of Object.keys(given))
		if (!Object.hasOwn(definitions, name)) throw new TypeError(`Unknown parameter "${name}"`);
	return params;
}

function selectedServices<R>(project: Project<R>, preset: Preset): Record<string, string> {
	const services = project.services ?? {};
	const selected: Record<string, string> = {};
	for (const [name, service] of Object.entries(services)) {
		const variant = preset.services?.[name] ?? service.default;
		if (!Object.hasOwn(service.variants, variant)) throw new Error(`Unknown service variant "${name}:${variant}"`);
		selected[name] = variant;
	}
	for (const name of Object.keys(preset.services ?? {}))
		if (!Object.hasOwn(services, name)) throw new Error(`Unknown service "${name}"`);
	return selected;
}

async function setupResources<R>(project: Project<R>, preset: Preset, acquired: Acquired): Promise<R> {
	const hooks = project.resources;
	// Without resource hooks nothing produces an R; scenarios then see `resources` as undefined.
	if (!hooks) return undefined as R;
	const resources = await hooks.setup({ preset });
	acquired.disposeResources = () => hooks.dispose(resources);
	return resources;
}

/** Names entities: an explicit ID or a preset override wins, otherwise the ID derives from the name. */
function createRef<R>(project: Project<R>, preset: Preset, refs: Record<string, string>): Ref {
	return (name, override) => {
		const presetOverride = preset.refs?.[name];
		if (override && presetOverride && override !== presetOverride)
			throw new Error(`Ref "${name}" override conflicts with preset`);
		const id = override ?? presetOverride ?? deterministicId(`${project.name}:${preset.scenario.id}:${name}`);
		if (refs[name] && refs[name] !== id) throw new Error(`Ref "${name}" already resolves to ${refs[name]}`);
		refs[name] = id;
		return id;
	};
}

function scenarioWorld(builder: WorldBuilder, ref: Ref, refs: Record<string, string>): ScenarioWorld {
	// The bot does not exist yet, so refs resolve against the names declared so far.
	const declared = (name: string): string => {
		if (refs[name] || Object.values(refs).includes(name)) return refs[name] ?? name;
		throw unknownRefError(refs, name);
	};
	return {
		builder,
		ref,
		bot: options => builder.botUser(options),
		guild: (name, options) => builder.registerGuild({ ...options, id: ref(name, options?.id) }).id,
		role: (name, guild, options) =>
			builder.registerRole(declared(guild), { ...options, id: ref(name, options?.id) }).id,
		channel: (name, guild, options) =>
			builder.registerChannel(declared(guild), { ...options, id: ref(name, options?.id) }).id,
		member: (name, guild, options) => {
			const id = ref(name);
			return builder.registerMember(declared(guild), { ...options, user: { ...apiUser({ id }), ...options?.user, id } })
				.user.id;
		},
		message: (name, channel, options) =>
			builder.registerMessage(declared(channel), { ...options, id: ref(name, options?.id) }).id,
	};
}

function createActor(
	bot: MockBot,
	builder: WorldBuilder,
	refs: Record<string, string>,
	key: string,
	spec: ActorSpec,
): Actor {
	const run = { bot, refs };
	const channel = bot.world.query.channel({ id: resolveRef(run, spec.channelId) });
	if (!channel) throw new Error(`Actor "${key}" channel ${spec.channelId} is missing`);
	const guildId = spec.guildId ? resolveRef(run, spec.guildId) : undefined;
	const userId = resolveRef(run, spec.userId);
	const world = builder.build();
	const member = guildId
		? world.members.find(entry => entry.guildId === guildId && entry.member.user.id === userId)?.member
		: undefined;
	if (guildId && !member) throw new Error(`Actor "${key}" member ${userId} is missing from guild ${guildId}`);
	return bot.actor({
		...(member ? { member } : { user: apiUser({ id: userId }) }),
		guildId,
		channel: world.channels.find(entry => entry.id === channel.id),
	});
}

function responseStatus(response: unknown): number | null {
	if (typeof response !== 'object' || response === null || !('status' in response)) return null;
	return typeof response.status === 'number' ? response.status : null;
}

function sessionEventOf(event: MockBotEvent): SessionEvent {
	switch (event.type) {
		case 'rest': {
			const { method, route, response, error } = event.action;
			const settled =
				event.phase === 'settled'
					? { status: responseStatus(response), ...(error ? { error: errorText(error) } : {}) }
					: {};
			return { type: 'rest', phase: event.phase, detail: toJson({ method, route, ...settled }) };
		}
		case 'dispatch': {
			const { dispatchId, kind, sessionKey, error } = event;
			return {
				type: 'dispatch',
				phase: event.phase,
				detail: toJson({ dispatchId, kind, sessionKey, ...(error ? { error: errorText(error) } : {}) }),
			};
		}
		case 'world':
			return { type: 'world', detail: toJson(event.diff) };
		case 'interaction':
			return { type: 'interaction', detail: toJson(event.change) };
	}
}
