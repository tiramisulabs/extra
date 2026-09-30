import type {
	ActionOutcome,
	BridgeResponse,
	Checkpoint,
	CommandSchema,
	Expectation,
	HostInfo,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	ProjectDescription,
	RunEndReason,
	SessionDescription,
	SessionLog,
} from '@slipher/lab/protocol';
import {
	createCheckpoint,
	PROTOCOL_VERSION,
	validateHostInfo,
	validateProjectDescription,
} from '@slipher/lab/protocol';
import type {
	Actor,
	Channel,
	CheckpointClient,
	InspectorEntry,
	LabClient,
	LabSnapshot,
	PendingModal,
	ScenarioChoice,
	VisibleMessage,
} from './bridge';
import { isRevisionMismatch, presetParams, sessionActors, sessionChannels } from './bridge';
import { errorText, shortRevision } from './format';
import { messageText } from './messages';

/**
 * A click or select recorded against a message ID only replays in the session that produced it, so the UI's
 * exact reference becomes a locator the runtime can find again: the channel, the component and the message text.
 */
export function semanticAction(action: LabAction, snapshot?: LabSnapshot): LabAction {
	if (action.kind !== 'user' || (action.verb !== 'click' && action.verb !== 'select') || !action.source.messageRef)
		return action;
	const channelId = snapshot?.session?.refs[action.source.channel] ?? action.source.channel;
	// The runtime owns the access rule; a channel the actor cannot view must fail there, not be rewritten here.
	if (
		!sessionChannels(snapshot?.session)
			.find(item => item.id === channelId)
			?.visibleTo.includes(action.actor)
	)
		return action;
	const source = snapshot?.conversations[`${action.actor}:${channelId}`]?.messages.find(
		item => item.id === action.source.messageRef,
	);
	if (!source) throw new Error(`Visible source message ${action.source.messageRef} is unavailable`);
	const contains = messageText(source.payload);
	return {
		...action,
		source: { channel: action.source.channel, customId: action.customId, ...(contains ? { contains } : {}) },
	};
}

export class HostError extends Error {
	constructor(
		readonly status: number,
		text: string,
		readonly code?: string,
		readonly details: { reason?: RunEndReason; checkpointRevision?: string; currentRevision?: string } = {},
	) {
		super(text);
	}
}

const REPLAY_NOTICE = 'Session ended to replay a checkpoint.';
const HOST_ENDED_NOTICE = 'The host ended the session.';
const STREAM_LOST = 'Event stream lost; reconnecting…';
/** Host events arrive in bursts; one refresh follows the last of them. */
const REFRESH_DEBOUNCE_MS = 100;
const WATCH_MIN_MS = 1000;
const WATCH_MAX_MS = 10_000;
const RUN_NOTICES: Record<RunEndReason, string> = {
	expired: 'Run expired after inactivity.',
	'max-lifetime': 'Run reached its time limit.',
	restarted: 'The preview restarted.',
	stopped: 'Run ended.',
	shutdown: 'The preview stopped.',
};
const isRunEndReason = (value: unknown): value is RunEndReason => typeof value === 'string' && value in RUN_NOTICES;
const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined);
/** A run that is gone or never existed; the launcher notice reports it, not an error. */
const isRunGone = (error: unknown) =>
	error instanceof HostError && (error.code === 'run-ended' || error.code === 'run-missing');

function hostError(response: Response, body: unknown): HostError {
	const fields: Record<string, unknown> = body && typeof body === 'object' ? { ...body } : {};
	const code = optionalString(fields.code);
	let text = `${response.status} ${response.statusText}`;
	if (code === 'run-limit') text = 'Run limit reached. Try again later.';
	else if ('error' in fields) text = String(fields.error);
	return new HostError(response.status, text, code, {
		reason: isRunEndReason(fields.reason) ? fields.reason : undefined,
		checkpointRevision: optionalString(fields.checkpointRevision),
		currentRevision: optionalString(fields.currentRevision),
	});
}

const detail = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

function inspectorEntries(log: SessionLog, inspect: InspectorSnapshot): LabSnapshot['inspector'] {
	return {
		actions: log.entries.map(({ seq, action, outcome }) => ({
			id: `action-${seq}`,
			kind: action.kind,
			label: 'verb' in action ? action.verb : action.op,
			detail: detail(outcome.error ?? outcome.summary),
			failed: !outcome.ok,
		})),
		rest: inspect.rest.map((call, index) => ({
			id: `rest-${index}`,
			label: `${call.method} ${call.route}`,
			detail: detail(call.error ?? call.response ?? ''),
			failed: Boolean(call.error),
		})),
		diagnostics: inspect.diagnostics.map((text, index) => ({ id: `diagnostic-${index}`, label: text, detail: '' })),
	};
}

const collectorEntries = (pending: InspectorSnapshot['pending']): InspectorEntry[] =>
	pending.collectors.map((collector, index) => ({
		id: `collector-${index}`,
		label: `${collector.kind} · ${collector.customIds?.join(', ') ?? ''}`,
		detail: collector.messageId,
	}));

export class HostClient implements LabClient, CheckpointClient {
	private listeners = new Set<(snapshot: LabSnapshot) => void>();
	private project?: ProjectDescription;
	private snapshot?: LabSnapshot;
	private stream?: EventSource;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private requestId = 0;
	/** Modals the server reports closed, plus closes sent but not yet confirmed. */
	private serverClosed = new Set<string>();
	private localCloses = new Set<string>();
	private dismissing = new Set<string>();
	private refreshing?: Promise<void>;
	/** Set when an event arrives during a load, so the load runs again with the newer state. */
	private stale = false;
	/** Bumped by `stop`, so a load that finishes afterwards cannot bring back the stopped session. */
	private generation = 0;
	private checking?: Promise<boolean>;
	private watchTimer?: ReturnType<typeof setTimeout>;
	/** Closes the stream once no listener is left. */
	private idleTimer?: ReturnType<typeof setTimeout>;
	/** This tab follows a running session. */
	private active = false;
	private host?: HostInfo;

	/** `request` exists for non-browser callers that must manage cookies and Origin themselves. */
	constructor(
		private readonly base = '',
		private readonly request: typeof fetch = (input, init) => fetch(input, init),
	) {}

	private emit(): void {
		if (this.snapshot) for (const listener of this.listeners) listener(this.snapshot);
	}
	private update(changes: Partial<LabSnapshot>): void {
		if (!this.snapshot) return;
		this.snapshot = { ...this.snapshot, ...changes };
		this.emit();
	}
	private fail(error: unknown): never {
		if (!isRunGone(error)) this.update({ error: errorText(error) });
		throw error;
	}
	private async json<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.request(`${this.base}${path}`, init);
		if (response.ok) return response.json();
		// Proxies can answer errors with HTML; keep the status instead of failing on the body.
		const error = hostError(response, await response.json().catch(() => ({})));
		if (error.code === 'run-ended' || (error.code === 'run-missing' && this.active)) this.endRun(error.details.reason);
		throw error;
	}
	private post<T>(path: string, body: unknown): Promise<T> {
		return this.json<T>(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	}
	private async rpc<T>(type: string, payload?: JsonValue | LabAction): Promise<T> {
		const response = await this.post<BridgeResponse>('/api/rpc', {
			version: PROTOCOL_VERSION,
			id: ++this.requestId,
			type,
			...(payload === undefined ? {} : { payload }),
		});
		if (!response.ok) throw new Error(response.error ?? `${type} failed`);
		return response.value as T;
	}
	private async fetchProject(): Promise<ProjectDescription> {
		const project = await this.json<unknown>('/api/describe');
		validateProjectDescription(project);
		return project;
	}
	private blank(project: ProjectDescription): LabSnapshot {
		return {
			project,
			conversations: {},
			commands: [],
			pending: { modals: [], collectors: [] },
			closedModals: [],
			inspector: { actions: [], rest: [], diagnostics: [] },
			host: this.host,
		};
	}
	async connect(): Promise<LabSnapshot> {
		if (this.snapshot) return this.snapshot;
		try {
			const host = await this.json<unknown>('/api/host');
			validateHostInfo(host);
			this.host = host;
			const project = await this.fetchProject();
			this.project = project;
			this.snapshot = this.blank(project);
			if (host.run.state === 'ended') this.snapshot.notice = RUN_NOTICES[host.run.reason ?? 'stopped'];
			// A hosted browser has no events to follow until Start creates its run.
			if (host.run.state === 'active') {
				this.openStream();
				if (host.run.session) await this.adoptRunningSession(project);
			}
			this.emit();
			return this.snapshot;
		} catch (error) {
			return this.fail(error);
		}
	}
	private openStream(): void {
		if (this.stream || typeof EventSource === 'undefined') return;
		const stream = new EventSource(`${this.base}/api/events`);
		this.stream = stream;
		for (const type of ['session-started', 'session-event', 'session-error'])
			stream.addEventListener(type, event => {
				// The run keeps one session; one started from another tab is the session this tab shows too.
				if (type === 'session-started') this.active = true;
				if (type === 'session-error') {
					const payload: unknown = JSON.parse(event.data);
					this.update({
						error: payload && typeof payload === 'object' && 'detail' in payload ? String(payload.detail) : event.data,
					});
				}
				if (this.active) this.scheduleRefresh();
			});
		stream.addEventListener('session-stopped', event => {
			const payload: unknown = JSON.parse(event.data);
			const reason = payload && typeof payload === 'object' && 'reason' in payload ? payload.reason : undefined;
			if (reason === 'replay') this.stop(REPLAY_NOTICE);
			else if (isRunEndReason(reason)) this.endRun(reason);
			else this.stop(HOST_ENDED_NOTICE);
		});
		stream.addEventListener('child-exit', event => {
			this.stop(`Session process exited: ${event.data}`);
		});
		stream.onerror = () => {
			if (this.stream !== stream) return;
			this.update({ error: STREAM_LOST });
			void this.checkHost();
			this.watchForReplacement();
		};
	}
	private closeStream(): void {
		this.stream?.close();
		this.stream = undefined;
	}
	/**
	 * Reads host metadata. A new instance is a restart or redeploy: its catalogue replaces ours and the
	 * returned notice says which. The metadata is only adopted once the new catalogue loaded.
	 */
	private async syncHost(): Promise<string | undefined> {
		const next = await this.json<unknown>('/api/host');
		validateHostInfo(next);
		const previous = this.host;
		if (!previous || next.instanceId === previous.instanceId) {
			this.host = next;
			return undefined;
		}
		this.project = await this.fetchProject();
		this.host = next;
		const revision = next.build?.revision;
		if (revision && revision !== previous.build?.revision)
			return `The preview was updated to ${shortRevision(revision)}.`;
		return next.mode === 'local' ? 'The lab host restarted.' : RUN_NOTICES.restarted;
	}
	/** A replaced host never keeps the old run: stop following it and say why. */
	private leaveReplacedHost(notice: string): void {
		this.stopWatching();
		this.closeStream();
		this.stop(notice, { clearError: true });
	}
	/** Tells a lost stream apart from a restarted or redeployed host, which never keeps the old run; false while unreachable. */
	private checkHost(): Promise<boolean> {
		this.checking ??= (async () => {
			try {
				const ended = this.host?.run.state === 'ended';
				const replaced = await this.syncHost();
				if (replaced) {
					this.leaveReplacedHost(replaced);
					if (this.host?.mode === 'local') this.openStream();
				} else if (this.host?.run.state === 'ended' && !ended) this.endRun(this.host.run.reason);
				else if (this.snapshot?.error === STREAM_LOST) this.clearError();
				return true;
			} catch {
				// Unreachable while the preview redeploys; the watcher asks again.
				return false;
			} finally {
				this.checking = undefined;
			}
		})();
		return this.checking;
	}
	/**
	 * A shutdown or a dropped stream leaves nothing to notice the replacement, so host metadata is polled until a
	 * new instance answers, or the same instance answers with the run still alive (a passing network loss).
	 */
	private watchForReplacement(delay = WATCH_MIN_MS): void {
		if (this.watchTimer) return;
		const known = this.host?.instanceId;
		this.watchTimer = setTimeout(async () => {
			const reached = await this.checkHost();
			this.watchTimer = undefined;
			const run = this.host?.run;
			const waiting = !reached || (run?.state === 'ended' && run.reason === 'shutdown');
			if (this.listeners.size && this.host?.instanceId === known && waiting)
				this.watchForReplacement(Math.min(delay * 2, WATCH_MAX_MS));
		}, delay);
	}
	private stopWatching(): void {
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = undefined;
	}
	/** A run is gone for good: nothing reattaches to it, and only an explicit Start creates a new one. */
	private endRun(reason?: RunEndReason): void {
		const hosted = this.host?.mode === 'hosted';
		if (reason === 'shutdown') {
			this.closeStream();
			if (this.host && hosted) this.host = { ...this.host, run: { state: 'ended', reason } };
			this.stop(hosted ? RUN_NOTICES.shutdown : 'The lab host stopped.', { clearError: true });
			this.watchForReplacement();
			return;
		}
		if (!this.host || !hosted) {
			this.stop(HOST_ENDED_NOTICE);
			return;
		}
		this.closeStream();
		this.host = { ...this.host, run: { state: 'ended', ...(reason ? { reason } : {}) } };
		this.stop(RUN_NOTICES[reason ?? 'stopped'], { clearError: true });
		if (reason === 'restarted') void this.checkHost();
	}
	/** A reload must show the session the host is still running instead of the launcher. */
	private async adoptRunningSession(project: ProjectDescription): Promise<void> {
		this.active = true;
		try {
			await this.refresh();
		} catch (error) {
			this.active = false;
			this.snapshot = this.blank(project);
			if (!(error instanceof HostError && error.status === 409)) throw error;
		}
	}
	/**
	 * The event stream lives while someone listens. The last listener leaving closes it on the next task, so an
	 * unsubscribe immediately followed by a subscribe (React StrictMode, a remount) keeps the same stream; a
	 * listener arriving after it closed reopens it and catches up on what it missed.
	 */
	subscribe(listener: (snapshot: LabSnapshot) => void): () => void {
		this.listeners.add(listener);
		clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (!this.stream && (this.active || this.host?.run.state === 'active')) {
			this.openStream();
			if (this.active) this.scheduleRefresh();
		}
		return () => {
			if (!this.listeners.delete(listener) || this.listeners.size) return;
			clearTimeout(this.idleTimer);
			this.idleTimer = setTimeout(() => {
				this.idleTimer = undefined;
				if (this.listeners.size) return;
				this.closeStream();
				this.stopWatching();
				clearTimeout(this.refreshTimer);
			});
		};
	}
	/**
	 * Drops every view of the stopped session so nothing stale stays on screen. `clearError` drops errors the
	 * ended run caused (a lost stream); otherwise the last error stays visible.
	 */
	private stop(notice: string, { clearError = false } = {}): void {
		if (!this.project) return;
		this.active = false;
		this.generation++;
		clearTimeout(this.refreshTimer);
		this.forgetClosedModals();
		this.snapshot = { ...this.blank(this.project), notice, error: clearError ? undefined : this.snapshot?.error };
		this.emit();
	}
	private scheduleRefresh(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			if (this.active) void this.refresh().catch(error => this.update({ error: errorText(error) }));
		}, REFRESH_DEBOUNCE_MS);
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) {
			this.stale = true;
			await this.refreshing;
			return;
		}
		this.refreshing = (async () => {
			do {
				this.stale = false;
				await this.load();
			} while (this.stale && this.active);
		})();
		try {
			await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}
	/** Every actor's view of every channel, keyed `actor:channel`. */
	private async loadConversations(actors: Actor[], channels: Channel[]): Promise<LabSnapshot['conversations']> {
		const conversations: LabSnapshot['conversations'] = {};
		await Promise.all(
			actors.flatMap(actor =>
				channels.map(async channel => {
					conversations[`${actor.key}:${channel.id}`] = await this.rpc('session.view', {
						actor: actor.key,
						channelRef: channel.id,
					});
				}),
			),
		);
		return conversations;
	}
	/** Each project inspector's value; one that throws shows its error instead. */
	private async loadProjections(project: ProjectDescription): Promise<Record<string, JsonValue>> {
		const projections: Record<string, JsonValue> = {};
		await Promise.all(
			project.inspectors.map(async name => {
				try {
					projections[name] = await this.rpc<JsonValue>('session.inspectProject', { name, args: null });
				} catch (error) {
					projections[name] = { error: errorText(error) };
				}
			}),
		);
		return projections;
	}
	/** Server-closed modals replace the known set; a local close is confirmed once the server reports it or the modal is gone. */
	private syncClosedModals(modals: PendingModal[]): void {
		this.serverClosed = new Set(modals.filter(item => item.closed).map(item => item.interactionId));
		for (const key of this.localCloses)
			if (this.serverClosed.has(key) || !modals.some(item => item.interactionId === key)) this.localCloses.delete(key);
	}
	private async load(): Promise<void> {
		const project = this.project;
		if (!project) throw new Error('Project description is unavailable');
		const generation = this.generation;
		const [session, inspect, log, commands] = await Promise.all([
			this.rpc<SessionDescription>('session.describe'),
			this.rpc<InspectorSnapshot>('session.inspect'),
			this.rpc<SessionLog>('session.log'),
			this.rpc<CommandSchema[]>('session.commandSchemas'),
		]);
		const [conversations, projections] = await Promise.all([
			this.loadConversations(
				session.actors.filter(actor => actor.channelId),
				sessionChannels(session),
			),
			this.loadProjections(project),
		]);
		if (generation !== this.generation) return;
		const pending = inspect.pending;
		// The lab renders modal payloads through its own looser component shape.
		const modals = pending.modals as unknown as PendingModal[];
		this.syncClosedModals(modals);
		this.snapshot = {
			error: this.snapshot?.error,
			project,
			session,
			conversations,
			commands,
			log,
			rawInspect: inspect,
			projections,
			pending: { modals, collectors: collectorEntries(pending) },
			closedModals: this.closedKeys(),
			inspector: inspectorEntries(log, inspect),
			host: this.host,
		};
		this.emit();
	}
	/** Start never posts a preset built from a catalogue a redeploy has replaced. */
	private async syncBeforeStart(): Promise<void> {
		if (!this.host) return;
		let replaced: string | undefined;
		try {
			replaced = await this.syncHost();
		} catch (error) {
			if (error instanceof HostError) throw error;
			throw new Error('The preview is not reachable. Try again in a moment.');
		}
		if (replaced) this.leaveReplacedHost(replaced);
	}
	async start(choice: ScenarioChoice): Promise<void> {
		try {
			await this.syncBeforeStart();
			const scenario = this.project?.scenarios.find(item => item.id === choice.scenarioId);
			if (!scenario) throw new Error(`Unknown scenario ${choice.scenarioId}`);
			await this.post('/api/session', {
				preset: {
					scenario: { id: scenario.id, version: scenario.version },
					params: presetParams(choice),
					services: choice.services,
				},
			});
			this.forgetClosedModals();
			this.active = true;
			if (this.host?.mode === 'hosted') this.host = { ...this.host, run: { state: 'active', session: true } };
			// The refresh below emits the new session; clearing here must not flash an empty launcher first.
			if (this.snapshot) this.snapshot = { ...this.snapshot, error: undefined, notice: undefined };
			this.openStream();
			await this.refresh();
		} catch (error) {
			this.fail(error);
		}
	}
	async act(action: LabAction): Promise<void> {
		try {
			const outcome = await this.rpc<ActionOutcome>('session.act', semanticAction(action, this.snapshot));
			if (!outcome.ok) throw new Error(outcome.error ?? 'Action failed');
			if (this.snapshot) this.snapshot = { ...this.snapshot, error: undefined };
			await this.refresh();
		} catch (error) {
			this.scheduleRefresh();
			this.fail(error);
		}
	}
	async listCheckpoints(): Promise<string[]> {
		try {
			return (await this.json<{ names: string[] }>('/api/checkpoints')).names;
		} catch (error) {
			// Hosted checkpoints belong to a run; a browser without one has none.
			if (isRunGone(error)) return [];
			throw error;
		}
	}
	async saveCheckpoint(name: string, arrival: Expectation[]): Promise<Checkpoint> {
		const checkpoint = createCheckpoint(await this.rpc<SessionLog>('session.log'), name, arrival);
		await this.post('/api/checkpoints', { checkpoint });
		return checkpoint;
	}
	async loadCheckpoint(name: string): Promise<Checkpoint> {
		return this.json<Checkpoint>(`/api/checkpoints/${encodeURIComponent(name)}`);
	}
	async replayCheckpoint(name: string, options?: { acceptRevision?: boolean }): Promise<void> {
		// The host stops the visual session before replaying, whether or not the replay passes;
		// a revision mismatch is refused before anything stops.
		try {
			await this.post(
				`/api/checkpoints/${encodeURIComponent(name)}/replay`,
				options?.acceptRevision ? { acceptRevision: true } : {},
			);
		} catch (error) {
			if (!isRevisionMismatch(error) && this.active) this.stop(REPLAY_NOTICE);
			throw error;
		}
		if (this.active) this.stop(REPLAY_NOTICE);
	}
	async exportCheckpoint(name: string, format: 'vitest' | 'node'): Promise<string> {
		return (await this.json<{ code: string }>(`/api/checkpoints/${encodeURIComponent(name)}/export?format=${format}`))
			.code;
	}
	private closedKeys(): string[] {
		return [...new Set([...this.serverClosed, ...this.localCloses])];
	}
	private forgetClosedModals(): void {
		this.serverClosed.clear();
		this.localCloses.clear();
	}
	/** Sends a client-state action; the runtime may refuse it (the modal timed out meanwhile), which runs `undo`. */
	private sendLocal(action: LabAction, undo: () => void): void {
		void this.rpc<ActionOutcome>('session.act', action)
			.then(outcome => {
				if (!outcome.ok) throw new Error(outcome.error ?? `${action.kind} action failed`);
			})
			.catch(error => {
				undo();
				this.update({ closedModals: this.closedKeys(), error: errorText(error) });
			})
			.finally(() => {
				void this.refresh().catch(() => undefined);
			});
	}
	/** Closing is client state on the host: the bot keeps waiting, and the modal's own trigger reopens it. */
	closeModal(actor: string, customId: string): void {
		const userId = sessionActors(this.snapshot?.session).find(item => item.key === actor)?.userId;
		const modal = this.snapshot?.pending.modals.find(item => item.customId === customId && item.userId === userId);
		if (!modal) return;
		const key = modal.interactionId;
		this.localCloses.add(key);
		this.update({ closedModals: this.closedKeys() });
		this.sendLocal({ kind: 'local', op: 'closeModal', actor, customId }, () => this.localCloses.delete(key));
	}
	reopenModal(key: string): void {
		const modal = this.snapshot?.pending.modals.find(item => item.interactionId === key);
		const actor = modal && sessionActors(this.snapshot?.session).find(item => item.userId === modal.userId)?.key;
		if (!modal || !actor) return;
		const wasClosed = this.serverClosed.has(key);
		this.localCloses.delete(key);
		this.serverClosed.delete(key);
		this.update({ closedModals: this.closedKeys() });
		this.sendLocal({ kind: 'local', op: 'reopenModal', actor, customId: modal.customId }, () => {
			if (wasClosed) this.serverClosed.add(key);
		});
	}
	/** Hides one of the actor's own ephemeral messages for that actor only, as Discord's Dismiss message does. */
	async dismissMessage(actor: string, channel: string, visible: VisibleMessage): Promise<void> {
		// A second click before the refresh must not reach the host: it targets exactly this message.
		// The runtime records the message text replay needs to find it again.
		const key = `${actor}:${visible.id}`;
		if (this.dismissing.has(key)) return;
		this.dismissing.add(key);
		try {
			await this.act({ kind: 'local', op: 'dismissMessage', actor, source: { channel, messageRef: visible.id } });
		} finally {
			this.dismissing.delete(key);
		}
	}
	clearError(): void {
		this.update({ error: undefined });
	}
}
