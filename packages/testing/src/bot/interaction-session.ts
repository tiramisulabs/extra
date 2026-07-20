import type { Dispatch } from './dispatch';
import type { ApiChannel, ApiMember, ApiUser } from './payloads';
import type { RecordedAction } from './rest';

export type CollectorMatch = string | readonly string[] | RegExp;

export type InputCheckpoint =
	| {
			kind: 'modal';
			ownerDispatchId: number;
			userId: string;
			customId?: string;
	  }
	| {
			kind: 'component';
			ownerDispatchId: number;
			messageId: string;
			channelId: string;
			guildId?: string;
			match: CollectorMatch;
	  };

export interface InteractionSessionContext {
	user?: ApiUser;
	member?: ApiMember;
	guildId?: string | null;
	channel?: ApiChannel;
	locale?: string;
	guildLocale?: string;
	applicationId?: string;
	permissions?: string;
	memberPermissions?: string;
	context?: number;
	integrationOwners?: Record<string, string>;
}

interface SessionState {
	readonly key: string;
	readonly dispatches: Set<Dispatch<unknown>>;
	readonly checkpoints: InputCheckpoint[];
	readonly errors: Map<number, unknown>;
	readonly listeners: Set<(event: SessionEvent) => void>;
	version: number;
	currentActions: RecordedAction[];
	context?: InteractionSessionContext;
}

interface SessionEvent {
	version: number;
	ownerDispatchId?: number;
	checkpoint?: InputCheckpoint;
	error?: unknown;
}

interface EventRegistration {
	promise: Promise<SessionEvent>;
	dispose(): void;
}

class SessionDispatchFailure {
	constructor(
		readonly dispatchId: number | undefined,
		readonly cause: unknown,
	) {}
}

export interface InteractionSessionDeps {
	actions(): readonly RecordedAction[];
	assertCheckpointReady(checkpoint: InputCheckpoint): void;
	onDispatchCompleted?(dispatchId: number): void;
}

export interface ConsumedComponentCheckpoint {
	ownerDispatchId: number;
	sessionKey: string;
	channelId: string;
	guildId?: string;
}

function defaultSessionKey(userId: string | undefined): string {
	return `user:${userId ?? '(system)'}`;
}

/**
 * Coordinates chronological user actions without changing raw Dispatch semantics.
 *
 * A step resolves when its causal dispatches complete or when one of them registers a real user-input
 * checkpoint. Rendering alone never yields a step. The next action consumes that checkpoint and waits for both
 * its own dispatch and the resumed owner.
 */
export class InteractionSessions {
	private readonly states = new Map<string, SessionState>();
	private readonly dispatchSession = new Map<number, string>();
	private latestKey?: string;

	constructor(private readonly deps: InteractionSessionDeps) {}

	keyForUser(userId: string | undefined): string {
		return defaultSessionKey(userId);
	}

	keyForDispatch(dispatchId: number): string | undefined {
		return this.dispatchSession.get(dispatchId);
	}

	latestSessionKey(): string | undefined {
		return this.latestKey;
	}

	context(key: string): InteractionSessionContext | undefined {
		return this.states.get(key)?.context;
	}

	captureContext(dispatchId: number, context: InteractionSessionContext): void {
		const key = this.dispatchSession.get(dispatchId);
		if (!key) return;
		this.state(key).context = context;
	}

	private move(dispatch: Dispatch<unknown>, key: string): SessionState {
		const dispatchId = dispatch.dispatchId;
		const previousKey = dispatchId === undefined ? undefined : this.dispatchSession.get(dispatchId);
		if (previousKey && previousKey !== key) this.states.get(previousKey)?.dispatches.delete(dispatch);
		const state = this.state(key);
		state.dispatches.add(dispatch);
		if (dispatchId !== undefined) this.dispatchSession.set(dispatchId, key);
		return state;
	}

	recordCheckpoint(checkpoint: InputCheckpoint): void {
		const key = this.dispatchSession.get(checkpoint.ownerDispatchId);
		if (!key) return;
		const state = this.state(key);
		try {
			this.deps.assertCheckpointReady(checkpoint);
		} catch (error) {
			state.errors.set(checkpoint.ownerDispatchId, error);
			this.signal(state, { ownerDispatchId: checkpoint.ownerDispatchId, error });
			return;
		}
		state.checkpoints.push(checkpoint);
		this.signal(state, { ownerDispatchId: checkpoint.ownerDispatchId, checkpoint });
	}

	async perform<T>(
		dispatch: Dispatch<T>,
		key = defaultSessionKey(dispatch.userId),
		resumedOwnerDispatchId?: number,
	): Promise<T> {
		const state = this.state(key);
		const activeBefore = this.active(state);
		const resumedOwner = activeBefore.find(candidate => candidate.dispatchId === resumedOwnerDispatchId);
		const unrelated = activeBefore.filter(candidate => candidate !== resumedOwner);
		if (unrelated.length > 0) {
			const ids = unrelated.map(candidate => candidate.dispatchId ?? '(unknown)').join(', ');
			throw new TypeError(
				`stateful step: user session "${key}" already has a pending flow (dispatch ${ids}). ` +
					'Finish that flow first, bind independent flows to different actors, or use bot.dispatch.* for raw concurrency.',
			);
		}

		this.throwPendingError(state);
		this.move(dispatch as Dispatch<unknown>, key);
		const startIndex = this.deps.actions().length;
		const baseline = state.version;
		const causalDispatches = new Set<Dispatch<unknown>>([
			dispatch as Dispatch<unknown>,
			...(resumedOwner ? [resumedOwner] : []),
		]);
		const causalIds = new Set(
			[...causalDispatches].map(candidate => candidate.dispatchId).filter((id): id is number => id !== undefined),
		);

		const changed = this.nextEvent(
			state,
			baseline,
			event => event.ownerDispatchId === undefined || causalIds.has(event.ownerDispatchId),
		);
		const execution = dispatch.startForSession();
		this.observe(dispatch, state, execution);

		let outcome: { kind: 'checkpoint'; event: SessionEvent } | { kind: 'completed' };
		try {
			outcome = await Promise.race([
				changed.promise.then(event => ({ kind: 'checkpoint' as const, event })),
				this.awaitCausalCompletion(causalDispatches).then(() => ({ kind: 'completed' as const })),
			]);

			if (outcome.kind === 'checkpoint' && outcome.event.error !== undefined) {
				if (outcome.event.ownerDispatchId !== undefined) {
					state.errors.delete(outcome.event.ownerDispatchId);
				}
				throw outcome.event.error;
			}
			if (outcome.kind === 'checkpoint' && outcome.event.checkpoint?.ownerDispatchId !== dispatch.dispatchId) {
				// A modal submit commonly wakes an older slash dispatch, which registers the next collector before
				// the modal-submit transport itself finishes. The user action must still finish its own dispatch;
				// only the checkpoint owner is allowed to remain parked.
				try {
					await execution;
				} catch (error) {
					if (dispatch.dispatchId !== undefined) state.errors.delete(dispatch.dispatchId);
					throw error;
				}
			}
			state.currentActions = this.scopedActions(state, startIndex);
			this.latestKey = key;
			this.throwPendingError(state, causalIds);

			if (outcome.kind === 'completed' || dispatch.isCompleted) return await execution;
			return dispatch.snapshotForSession();
		} catch (error) {
			const failure = error instanceof SessionDispatchFailure ? error : undefined;
			if (failure?.dispatchId !== undefined) state.errors.delete(failure.dispatchId);
			if (dispatch.dispatchId !== undefined && failure === undefined) {
				state.errors.delete(dispatch.dispatchId);
			}
			state.currentActions = this.scopedActions(state, startIndex);
			this.latestKey = key;
			throw failure?.cause ?? error;
		} finally {
			changed.dispose();
		}
	}

	currentActions(key = this.latestKey): readonly RecordedAction[] {
		if (!key) return [];
		return this.states.get(key)?.currentActions ?? [];
	}

	checkpoints(key: string): readonly InputCheckpoint[] {
		return this.states.get(key)?.checkpoints ?? [];
	}

	hasModalCheckpoint(key: string, customId: string, userId: string): boolean {
		return (
			this.states
				.get(key)
				?.checkpoints.some(
					checkpoint => checkpoint.kind === 'modal' && checkpoint.userId === userId && checkpoint.customId === customId,
				) ?? false
		);
	}

	consumeModal(key: string, customId: string): number | undefined {
		const state = this.state(key);
		const index = state.checkpoints.findIndex(
			checkpoint => checkpoint.kind === 'modal' && checkpoint.customId === customId,
		);
		if (index === -1) return undefined;
		const [checkpoint] = state.checkpoints.splice(index, 1);
		return checkpoint.ownerDispatchId;
	}

	discardModal(ownerDispatchId: number | undefined, userId: string): void {
		if (ownerDispatchId === undefined) return;
		const key = this.dispatchSession.get(ownerDispatchId);
		if (!key) return;
		const state = this.states.get(key);
		if (!state) return;
		for (let index = state.checkpoints.length - 1; index >= 0; index--) {
			const checkpoint = state.checkpoints[index];
			if (
				checkpoint.kind === 'modal' &&
				checkpoint.ownerDispatchId === ownerDispatchId &&
				checkpoint.userId === userId
			) {
				state.checkpoints.splice(index, 1);
			}
		}
	}

	discardCheckpoint(checkpoint: InputCheckpoint): void {
		for (const state of this.states.values()) {
			const index = state.checkpoints.indexOf(checkpoint);
			if (index !== -1) {
				state.checkpoints.splice(index, 1);
				return;
			}
		}
	}

	consumeComponent(key: string, customId: string, messageId: string): ConsumedComponentCheckpoint | undefined {
		const state = this.state(key);
		const index = state.checkpoints.findIndex(
			checkpoint =>
				checkpoint.kind === 'component' &&
				checkpoint.messageId === messageId &&
				matchesCollector(checkpoint.match, customId),
		);
		if (index === -1) return undefined;
		const [checkpoint] = state.checkpoints.splice(index, 1);
		if (checkpoint.kind !== 'component') return undefined;
		return {
			ownerDispatchId: checkpoint.ownerDispatchId,
			sessionKey: key,
			channelId: checkpoint.channelId,
			...(checkpoint.guildId === undefined ? {} : { guildId: checkpoint.guildId }),
		};
	}

	componentCheckpoint(key: string, customId: string, messageId: string): ConsumedComponentCheckpoint | undefined {
		const state = this.states.get(key);
		const checkpoint = state?.checkpoints.find(
			candidate =>
				candidate.kind === 'component' &&
				candidate.messageId === messageId &&
				matchesCollector(candidate.match, customId),
		);
		if (!state || checkpoint?.kind !== 'component') return undefined;
		return {
			ownerDispatchId: checkpoint.ownerDispatchId,
			sessionKey: key,
			channelId: checkpoint.channelId,
			...(checkpoint.guildId === undefined ? {} : { guildId: checkpoint.guildId }),
		};
	}

	componentCheckpointBySource(customId: string, messageId: string): ConsumedComponentCheckpoint | undefined {
		const match = this.componentCheckpointMatch(customId, messageId);
		if (!match) return undefined;
		return {
			ownerDispatchId: match.checkpoint.ownerDispatchId,
			sessionKey: match.state.key,
			channelId: match.checkpoint.channelId,
			...(match.checkpoint.guildId === undefined ? {} : { guildId: match.checkpoint.guildId }),
		};
	}

	consumeComponentBySource(customId: string, messageId: string): ConsumedComponentCheckpoint | undefined {
		const match = this.componentCheckpointMatch(customId, messageId);
		if (!match) return undefined;
		const index = match.state.checkpoints.indexOf(match.checkpoint);
		if (index !== -1) match.state.checkpoints.splice(index, 1);
		return {
			ownerDispatchId: match.checkpoint.ownerDispatchId,
			sessionKey: match.state.key,
			channelId: match.checkpoint.channelId,
			...(match.checkpoint.guildId === undefined ? {} : { guildId: match.checkpoint.guildId }),
		};
	}

	private componentCheckpointMatch(
		customId: string,
		messageId: string,
	):
		| {
				state: SessionState;
				checkpoint: Extract<InputCheckpoint, { kind: 'component' }>;
		  }
		| undefined {
		const matches: {
			state: SessionState;
			checkpoint: Extract<InputCheckpoint, { kind: 'component' }>;
		}[] = [];
		for (const state of this.states.values()) {
			for (const checkpoint of state.checkpoints) {
				if (
					checkpoint.kind === 'component' &&
					checkpoint.messageId === messageId &&
					matchesCollector(checkpoint.match, customId)
				) {
					matches.push({ state, checkpoint });
				}
			}
		}
		if (matches.length > 1) {
			throw new TypeError(
				`component "${customId}" has multiple active waits on source message "${messageId}". ` +
					'Stop the duplicate collectors before dispatching the component.',
			);
		}
		const match = matches[0];
		return match;
	}

	reset(): void {
		this.states.clear();
		this.dispatchSession.clear();
		this.latestKey = undefined;
	}

	takePendingError(): unknown | undefined {
		for (const state of this.states.values()) {
			const first = state.errors.entries().next().value as [number, unknown] | undefined;
			if (!first) continue;
			state.errors.delete(first[0]);
			return first[1];
		}
		return undefined;
	}

	private observe<T>(dispatch: Dispatch<T>, state: SessionState, execution: Promise<T>): void {
		const dispatchId = dispatch.dispatchId;
		if (dispatchId === undefined) {
			execution.catch(error => this.signal(state, { error }));
			return;
		}
		void execution.then(
			() => {
				state.dispatches.delete(dispatch as Dispatch<unknown>);
				this.discardCheckpoints(state, dispatchId);
				this.deps.onDispatchCompleted?.(dispatchId);
			},
			error => {
				state.dispatches.delete(dispatch as Dispatch<unknown>);
				this.discardCheckpoints(state, dispatchId);
				this.deps.onDispatchCompleted?.(dispatchId);
				state.errors.set(dispatchId, error);
				this.signal(state, { ownerDispatchId: dispatchId, error });
			},
		);
	}

	private async awaitCausalCompletion(dispatches: ReadonlySet<Dispatch<unknown>>): Promise<void> {
		await Promise.all(
			[...dispatches].map(dispatch => {
				const completion = dispatch.completionForSession();
				if (!completion) return Promise.resolve();
				return completion.then(
					() => undefined,
					error => {
						throw new SessionDispatchFailure(dispatch.dispatchId, error);
					},
				);
			}),
		);
	}

	private active(state: SessionState): Dispatch<unknown>[] {
		return [...state.dispatches].filter(dispatch => dispatch.started && !dispatch.isCompleted);
	}

	private scopedActions(state: SessionState, startIndex: number): RecordedAction[] {
		return this.deps
			.actions()
			.slice(startIndex)
			.filter(
				action =>
					action.sessionKey === state.key ||
					(action.dispatchId !== undefined && this.dispatchSession.get(action.dispatchId) === state.key),
			);
	}

	private discardCheckpoints(state: SessionState, ownerDispatchId: number): void {
		for (let index = state.checkpoints.length - 1; index >= 0; index--) {
			if (state.checkpoints[index].ownerDispatchId === ownerDispatchId) {
				state.checkpoints.splice(index, 1);
			}
		}
	}

	private nextEvent(
		state: SessionState,
		afterVersion: number,
		accept: (event: SessionEvent) => boolean,
	): EventRegistration {
		let listener: ((event: SessionEvent) => void) | undefined;
		const promise = new Promise<SessionEvent>(resolve => {
			listener = (event: SessionEvent) => {
				if (event.version <= afterVersion || !accept(event)) return;
				if (listener) state.listeners.delete(listener);
				resolve(event);
			};
			state.listeners.add(listener);
		});
		return {
			promise,
			dispose: () => {
				if (listener) state.listeners.delete(listener);
			},
		};
	}

	private signal(state: SessionState, event: Omit<SessionEvent, 'version'>): void {
		state.version++;
		const next = { ...event, version: state.version };
		for (const listener of [...state.listeners]) listener(next);
	}

	private throwPendingError(state: SessionState, dispatchIds?: ReadonlySet<number>): void {
		const first = [...state.errors.entries()].find(
			([dispatchId]) => dispatchIds === undefined || dispatchIds.has(dispatchId),
		);
		if (!first) return;
		state.errors.delete(first[0]);
		throw first[1];
	}

	private state(key: string): SessionState {
		let state = this.states.get(key);
		if (!state) {
			state = {
				key,
				dispatches: new Set(),
				checkpoints: [],
				errors: new Map(),
				listeners: new Set(),
				version: 0,
				currentActions: [],
			};
			this.states.set(key, state);
		}
		return state;
	}
}

export function matchesCollector(match: CollectorMatch, customId: string): boolean {
	if (typeof match === 'string') return match === customId;
	if (match instanceof RegExp) {
		const previousLastIndex = match.lastIndex;
		match.lastIndex = 0;
		const matches = match.test(customId);
		match.lastIndex = previousLastIndex;
		return matches;
	}
	return match.includes(customId);
}
