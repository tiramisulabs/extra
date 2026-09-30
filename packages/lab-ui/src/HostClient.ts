import type {
	ActionOutcome,
	BridgeResponse,
	Checkpoint,
	CommandSchema,
	Expectation,
	HostInfo,
	InspectorSnapshot,
	RunEndReason,
	SessionDescription,
	SessionLog,
} from '@slipher/lab/protocol';
import { PROTOCOL_VERSION, validateHostInfo, validateProjectDescription } from '@slipher/lab/protocol';
import type {
	InspectorEntry,
	JsonValue,
	LabAction,
	LabClient,
	LabSnapshot,
	ProjectDescription,
	VisibleMessage,
} from './bridge';

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function entry(id: string, label: string, value: unknown, failed = false): InspectorEntry {
	return { id, label, detail: typeof value === 'string' ? value : JSON.stringify(value), failed };
}

export function semanticAction(action: LabAction, snapshot?: LabSnapshot): LabAction {
	if (action.kind !== 'user' || (action.verb !== 'click' && action.verb !== 'select') || !action.source.messageRef)
		return action;
	const channelId = snapshot?.session?.refs[action.source.channel] ?? action.source.channel;
	// The runtime owns the access rule; a channel the actor cannot view must fail there, not be rewritten here.
	if (!snapshot?.channels.find(item => item.id === channelId)?.visibleTo.includes(action.actor)) return action;
	const source = snapshot.conversations[`${action.actor}:${channelId}`]?.messages.find(
		item => item.id === action.source.messageRef,
	);
	if (!source) throw new Error(`Visible source message ${action.source.messageRef} is unavailable`);
	return {
		...action,
		source: {
			channel: action.source.channel,
			customId: action.customId,
			...(source.payload.content ? { contains: source.payload.content } : {}),
		},
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

/** Keeps a readable prefix of commit or content hashes and any suffix such as `-dirty-…`. */
export function shortRevision(revision: string): string {
	return revision.replace(/^((?:content-)?[0-9a-f]{7})[0-9a-f]+/i, '$1');
}

/** The pending modal instance; a later modal with the same custom ID is a different instance. */
export function modalKey(modal: { interactionId?: string; userId: string; customId: string }): string {
	return modal.interactionId ?? `${modal.userId}:${modal.customId}`;
}

const REPLAY_NOTICE = 'Session ended to replay a checkpoint.';
const STREAM_LOST = 'Event stream lost; reconnecting…';
const WATCH_MAX_MS = 10_000;
const RUN_NOTICES: Record<RunEndReason, string> = {
	expired: 'Run expired after inactivity.',
	'max-lifetime': 'Run reached its time limit.',
	restarted: 'The preview restarted.',
	stopped: 'Run ended.',
	shutdown: 'The preview stopped.',
};

export class HostClient implements LabClient {
	private listeners = new Set<(snapshot: LabSnapshot) => void>();
	private project?: ProjectDescription;
	private snapshot?: LabSnapshot;
	private stream?: EventSource;
	private timer?: ReturnType<typeof setTimeout>;
	private requestId = 0;
	/** Modals the server reports closed, plus closes sent but not yet confirmed. */
	private serverClosed = new Set<string>();
	private localCloses = new Set<string>();
	private dismissing = new Set<string>();
	private refreshing?: Promise<void>;
	private checking?: Promise<boolean>;
	private watchTimer?: ReturnType<typeof setTimeout>;
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
	private fail(error: unknown): never {
		// An ended run is reported by the launcher notice, not as an error.
		const ended = error instanceof HostError && (error.code === 'run-ended' || error.code === 'run-missing');
		if (this.snapshot && !ended) {
			this.snapshot = { ...this.snapshot, error: message(error) };
			this.emit();
		}
		throw error;
	}
	private async json<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await this.request(`${this.base}${path}`, init);
		const body: unknown = await response.json();
		if (!response.ok) {
			const fields = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
			const code = typeof fields.code === 'string' ? fields.code : undefined;
			const text =
				code === 'run-limit'
					? 'Run limit reached. Try again later.'
					: 'error' in fields
						? String(fields.error)
						: `${response.status} ${response.statusText}`;
			const error = new HostError(response.status, text, code, {
				reason: typeof fields.reason === 'string' ? (fields.reason as RunEndReason) : undefined,
				checkpointRevision: typeof fields.checkpointRevision === 'string' ? fields.checkpointRevision : undefined,
				currentRevision: typeof fields.currentRevision === 'string' ? fields.currentRevision : undefined,
			});
			if (code === 'run-ended' || (code === 'run-missing' && this.active)) this.endRun(error.details.reason);
			throw error;
		}
		return body as T;
	}
	private async rpc<T>(type: string, payload?: JsonValue): Promise<T> {
		const response = await this.json<BridgeResponse>('/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				version: PROTOCOL_VERSION,
				id: ++this.requestId,
				type,
				...(payload === undefined ? {} : { payload }),
			}),
		});
		if (!response.ok) throw new Error(response.error ?? `${type} failed`);
		return response.value as T;
	}
	private blank(project: ProjectDescription): LabSnapshot {
		const scenario = project.scenarios[0];
		return {
			connection: 'disconnected',
			project,
			scenarioId: scenario?.id ?? '',
			params: Object.fromEntries(
				Object.entries(scenario?.params ?? {}).map(([name, definition]) => [name, definition.default]),
			),
			actors: [],
			channels: [],
			conversations: {},
			commands: [],
			pending: { modals: [], collectors: [] },
			inspector: { actions: [], rest: [], world: [], diagnostics: [], project: [] },
			host: this.host,
		};
	}
	async connect(): Promise<LabSnapshot> {
		if (this.snapshot) return this.snapshot;
		try {
			const host = await this.json<unknown>('/api/host');
			validateHostInfo(host);
			this.host = host;
			const project = await this.json<unknown>('/api/describe');
			validateProjectDescription(project);
			this.project = project;
			this.snapshot = this.blank(project);
			if (host.run.state === 'ended') this.snapshot.notice = RUN_NOTICES[host.run.reason ?? 'stopped'];
			// A hosted browser has no events to follow until Start creates its run.
			if (host.run.state === 'active') this.openStream();
			if (host.run.state === 'active' && host.run.session) await this.adoptRunningSession(project);
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
				if (type === 'session-error' && this.snapshot) {
					const payload: unknown = JSON.parse(event.data);
					this.snapshot = {
						...this.snapshot,
						error: payload && typeof payload === 'object' && 'detail' in payload ? String(payload.detail) : event.data,
					};
					this.emit();
				}
				if (this.active) this.scheduleRefresh();
			});
		stream.addEventListener('session-stopped', event => {
			const payload: unknown = JSON.parse(event.data);
			const reason = payload && typeof payload === 'object' && 'reason' in payload ? String(payload.reason) : '';
			if (reason === 'replay') this.stop(REPLAY_NOTICE);
			else if (reason in RUN_NOTICES) this.endRun(reason as RunEndReason);
			else this.stop('The host ended the session.');
		});
		stream.addEventListener('child-exit', event => {
			this.stop(`Session process exited: ${event.data}`);
		});
		stream.onerror = () => {
			if (this.stream !== stream) return;
			if (this.snapshot) {
				this.snapshot = { ...this.snapshot, error: STREAM_LOST };
				this.emit();
			}
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
		if (previous && next.instanceId !== previous.instanceId) {
			const project = await this.json<unknown>('/api/describe');
			validateProjectDescription(project);
			this.project = project;
			this.host = next;
			const revision = next.build?.revision;
			if (revision && revision !== previous.build?.revision)
				return `The preview was updated to ${shortRevision(revision)}.`;
			return next.mode === 'local' ? 'The lab host restarted.' : RUN_NOTICES.restarted;
		}
		this.host = next;
		return undefined;
	}
	/** Tells a lost stream apart from a restarted or redeployed host, which never keeps the old run; false while unreachable. */
	private checkHost(): Promise<boolean> {
		this.checking ??= (async () => {
			try {
				const ended = this.host?.run.state === 'ended';
				const replaced = await this.syncHost();
				if (replaced) {
					this.stopWatching();
					this.closeStream();
					this.stop(replaced, { clearError: true });
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
	private watchForReplacement(delay = 1000): void {
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
		if (reason === 'shutdown') {
			this.closeStream();
			if (this.host?.mode === 'hosted') this.host = { ...this.host, run: { state: 'ended', reason } };
			this.stop(this.host?.mode === 'hosted' ? RUN_NOTICES.shutdown : 'The lab host stopped.', { clearError: true });
			this.watchForReplacement();
			return;
		}
		if (this.host?.mode !== 'hosted') {
			this.stop('The host ended the session.');
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
	subscribe(listener: (snapshot: LabSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) {
				this.closeStream();
				this.stopWatching();
				if (this.timer) clearTimeout(this.timer);
			}
		};
	}
	/**
	 * Drops every view of the stopped session so nothing stale stays on screen. `clearError` drops errors the
	 * ended run caused (a lost stream); otherwise the last error stays visible.
	 */
	private stop(notice: string, { clearError = false } = {}): void {
		if (!this.project) return;
		this.active = false;
		if (this.timer) clearTimeout(this.timer);
		this.forgetClosedModals();
		this.snapshot = { ...this.blank(this.project), notice, error: clearError ? undefined : this.snapshot?.error };
		this.emit();
	}
	private scheduleRefresh(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (!this.active) return;
			void this.refresh().catch(error => {
				if (this.snapshot) {
					this.snapshot = { ...this.snapshot, error: message(error) };
					this.emit();
				}
			});
		}, 100);
	}
	private async refresh(): Promise<void> {
		if (this.refreshing) {
			await this.refreshing;
			return;
		}
		this.refreshing = this.load();
		try {
			await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}
	private async load(): Promise<void> {
		if (!this.project) throw new Error('Project description is unavailable');
		const [description, inspect, log, commands] = await Promise.all([
			this.rpc<SessionDescription>('session.describe'),
			this.rpc<InspectorSnapshot>('session.inspect'),
			this.rpc<SessionLog>('session.log'),
			this.rpc<CommandSchema[]>('session.commandSchemas'),
		]);
		const channels = description.guilds.flatMap(guild =>
			guild.channels.map(channel => ({ ...channel, guildId: guild.id })),
		);
		const actors = description.actors.filter(actor => actor.channelId);
		const conversations: LabSnapshot['conversations'] = {};
		await Promise.all(
			actors.flatMap(actor =>
				channels.map(async channel => {
					const view = await this.rpc<{ messages: VisibleMessage[]; diagnostics: string[] }>('session.view', {
						actor: actor.key,
						channelRef: channel.id,
					});
					conversations[`${actor.key}:${channel.id}`] = view;
				}),
			),
		);
		const pending = inspect.pending as {
			modals?: LabSnapshot['pending']['modals'];
			collectors?: { messageId: string; customIds?: string[]; kind: string }[];
		};
		const modals = pending.modals ?? [];
		this.serverClosed = new Set(modals.filter(item => item.closed).map(modalKey));
		for (const key of this.localCloses)
			if (this.serverClosed.has(key) || !modals.some(item => modalKey(item) === key)) this.localCloses.delete(key);
		const rest = Array.isArray(inspect.rest) ? inspect.rest : [];
		const projectionValues: Record<string, JsonValue> = {};
		const projections = await Promise.all(
			this.project.inspectors.map(async name => {
				try {
					const value = await this.rpc<JsonValue>('session.inspectProject', { name, args: null });
					projectionValues[name] = value;
					return entry(name, name, value);
				} catch (error) {
					return entry(name, name, message(error), true);
				}
			}),
		);
		this.snapshot = {
			connection: 'connected',
			error: this.snapshot?.error,
			project: this.project,
			session: description,
			scenarioId: description.preset.scenario.id,
			params: description.preset.params ?? {},
			actors: description.actors,
			channels,
			conversations,
			commands,
			log,
			rawInspect: inspect,
			projections: projectionValues,
			pending: {
				modals: pending.modals ?? [],
				collectors: (pending.collectors ?? []).map((collector, index) =>
					entry(
						`collector-${index}`,
						`${collector.kind} · ${collector.customIds?.join(', ') ?? ''}`,
						collector.messageId,
					),
				),
			},
			inspector: {
				actions: [
					...log.entries.map(item =>
						entry(
							`action-${item.seq}`,
							`${item.action.kind.toUpperCase()} · ${'verb' in item.action ? item.action.verb : item.action.op}`,
							item.outcome.error ?? item.outcome.summary,
							!item.outcome.ok,
						),
					),
				],
				rest: rest.map((item, index) => {
					const call = item as { method?: string; route?: string; error?: unknown; response?: { status?: number } };
					return entry(
						`rest-${index}`,
						`${call.response?.status ?? ''} · ${call.method ?? ''} ${call.route ?? ''}`,
						call.error ?? call.response ?? '',
						Boolean(call.error),
					);
				}),
				world: [entry('world', 'Discord state', inspect.world)],
				diagnostics: inspect.diagnostics.map((text, index) => entry(`diagnostic-${index}`, text, '')),
				project: projections,
			},
			closedModals: this.closedKeys(),
			names: description.names,
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
		if (!replaced) return;
		this.stopWatching();
		this.closeStream();
		this.stop(replaced, { clearError: true });
	}
	async start(input: {
		scenarioId: string;
		params: Record<string, JsonValue>;
		services: Record<string, string>;
	}): Promise<void> {
		try {
			await this.syncBeforeStart();
			if (!this.project) throw new Error('Project description is unavailable');
			const scenario = this.project.scenarios.find(item => item.id === input.scenarioId);
			if (!scenario) throw new Error(`Unknown scenario ${input.scenarioId}`);
			await this.json('/api/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					preset: {
						scenario: { id: scenario.id, version: scenario.version },
						params: input.params,
						services: input.services,
					},
				}),
			});
			this.forgetClosedModals();
			this.active = true;
			if (this.host?.mode === 'hosted') this.host = { ...this.host, run: { state: 'active', session: true } };
			if (this.snapshot) this.snapshot = { ...this.snapshot, error: undefined, notice: undefined };
			this.openStream();
			await this.refresh();
		} catch (error) {
			this.fail(error);
		}
	}
	async act(action: LabAction): Promise<void> {
		try {
			const recorded = semanticAction(action, this.snapshot);
			const outcome = await this.rpc<ActionOutcome>('session.act', recorded as unknown as JsonValue);
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
			if (error instanceof HostError && (error.code === 'run-missing' || error.code === 'run-ended')) return [];
			throw error;
		}
	}
	async saveCheckpoint(name: string, arrival: Expectation[]): Promise<Checkpoint> {
		const log = await this.rpc<SessionLog>('session.log');
		const checkpoint: Checkpoint = {
			version: 1,
			labVersion: log.labVersion,
			protocolVersion: log.protocolVersion,
			name,
			preset: log.preset,
			actions: log.entries.map(item => item.action),
			outcomes: log.entries.map((item, action) => ({
				action,
				ok: item.outcome.ok,
				dispatchCount: item.outcome.dispatchIds.length,
				...(item.outcome.error ? { error: `^${item.outcome.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` } : {}),
			})),
			arrival,
		};
		await this.json('/api/checkpoints', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ checkpoint }),
		});
		return checkpoint;
	}
	async loadCheckpoint(name: string): Promise<Checkpoint> {
		return this.json<Checkpoint>(`/api/checkpoints/${encodeURIComponent(name)}`);
	}
	async replayCheckpoint(name: string, options?: { acceptRevision?: boolean }): Promise<void> {
		// The host stops the visual session before replaying, whether or not the replay passes;
		// a revision mismatch is refused before anything stops.
		try {
			await this.json(`/api/checkpoints/${encodeURIComponent(name)}/replay`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(options?.acceptRevision ? { acceptRevision: true } : {}),
			});
		} catch (error) {
			if (!(error instanceof HostError && error.code === 'revision-mismatch') && this.active) this.stop(REPLAY_NOTICE);
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
	/** Sends a client-state action; the runtime may refuse it (the modal timed out meanwhile), which undoes `optimistic`. */
	private sendLocal(action: LabAction, undo: () => void): void {
		void this.rpc<ActionOutcome>('session.act', action as unknown as JsonValue)
			.then(outcome => {
				if (!outcome.ok) throw new Error(outcome.error ?? `${action.kind} action failed`);
			})
			.catch(error => {
				undo();
				if (this.snapshot) {
					this.snapshot = { ...this.snapshot, closedModals: this.closedKeys(), error: message(error) };
					this.emit();
				}
			})
			.finally(() => {
				void this.refresh().catch(() => undefined);
			});
	}
	/** Closing is client state on the host: the bot keeps waiting, and the modal's own trigger reopens it. */
	closeModal(actor: string, customId: string): void {
		const modal = this.snapshot?.pending.modals.find(
			item =>
				item.customId === customId && this.snapshot?.actors.find(value => value.key === actor)?.userId === item.userId,
		);
		if (!modal || !this.snapshot) return;
		const key = modalKey(modal);
		this.localCloses.add(key);
		this.snapshot = { ...this.snapshot, closedModals: this.closedKeys() };
		this.emit();
		this.sendLocal({ kind: 'local', op: 'closeModal', actor, customId }, () => this.localCloses.delete(key));
	}
	reopenModal(key: string): void {
		const modal = this.snapshot?.pending.modals.find(item => modalKey(item) === key);
		const actor = this.snapshot?.actors.find(item => item.userId === modal?.userId)?.key;
		if (!modal || !actor || !this.snapshot) return;
		const wasClosed = this.serverClosed.has(key);
		this.localCloses.delete(key);
		this.serverClosed.delete(key);
		this.snapshot = { ...this.snapshot, closedModals: this.closedKeys() };
		this.emit();
		this.sendLocal({ kind: 'local', op: 'reopenModal', actor, customId: modal.customId }, () => {
			if (wasClosed) this.serverClosed.add(key);
		});
	}
	/** Hides one of the actor's own ephemeral messages for that actor only, as Discord's Dismiss message does. */
	async dismissMessage(actor: string, channel: string, visible: VisibleMessage): Promise<void> {
		// A second click before the refresh must not reach the host: it targets exactly this message.
		const key = `${actor}:${visible.id}`;
		if (this.dismissing.has(key)) return;
		this.dismissing.add(key);
		const payload = visible.payload;
		// The content locator is only what replay uses when message IDs differ; the live action is exact.
		const contains = payload.content || payload.embeds?.[0]?.title || payload.embeds?.[0]?.description;
		try {
			await this.act({
				kind: 'local',
				op: 'dismissMessage',
				actor,
				source: { channel, messageRef: visible.id, ...(contains ? { contains } : {}) },
			});
		} finally {
			this.dismissing.delete(key);
		}
	}
	clearError(): void {
		if (this.snapshot) {
			this.snapshot = { ...this.snapshot, error: undefined };
			this.emit();
		}
	}
}
