import { InvalidRequestBudget, SlidingWindow } from './gates';
import { ProxyError, type ProxyErrorCode, proxyError } from './protocol';

interface PendingEntry {
	requestId: string;
	exempt: boolean;
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: ProxyError | ClientDisconnectedError) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface SubmitOptions<T> {
	requestId: string;
	exempt: boolean;
	run: () => Promise<T>;
	signal?: AbortSignal;
}

export class ClientDisconnectedError extends Error {
	constructor() {
		super('Client disconnected before proxy dispatch.');
	}
}

export class RequestScheduler {
	private readonly pending: PendingEntry[] = [];
	private readonly inFlightIds = new Set<string>();
	private gateTimer?: NodeJS.Timeout;
	private accepting = true;
	private tokenQuarantined = false;

	constructor(
		private readonly maxPendingRequests: number,
		private readonly queueTimeout: number,
		readonly globalGate: SlidingWindow,
		readonly invalidBudget: InvalidRequestBudget,
		private readonly onStateChange: () => void,
	) {}

	get pendingCount(): number {
		return this.pending.length;
	}

	get inFlightCount(): number {
		return this.inFlightIds.size;
	}

	get inFlight(): readonly string[] {
		return [...this.inFlightIds];
	}

	get draining(): boolean {
		return !this.accepting;
	}

	get quarantined(): boolean {
		return this.tokenQuarantined || this.invalidBudget.blockedFor(Date.now()) > 0;
	}

	quarantineToken(): void {
		if (this.tokenQuarantined) return;
		this.tokenQuarantined = true;
		this.rejectPending('PROXY_QUARANTINED', 'Proxy is quarantined.');
		this.onStateChange();
	}

	recordInvalid(now = Date.now()): void {
		this.invalidBudget.record(now);
		const blockedFor = this.invalidBudget.blockedFor(now);
		if (!blockedFor) return;
		this.rejectPending('PROXY_QUARANTINED', 'Invalid request budget is exhausted.');
		this.schedulePump(blockedFor);
		this.onStateChange();
	}

	private rejection(code: ProxyErrorCode, requestId: string, message: string): ProxyError {
		return new ProxyError(proxyError(code, 'not_dispatched', requestId, message));
	}

	submit<T>(options: SubmitOptions<T>): Promise<T> {
		if (!this.accepting) {
			return Promise.reject(this.rejection('PROXY_DRAINING', options.requestId, 'Proxy is draining.'));
		}
		if (this.quarantined) {
			return Promise.reject(this.rejection('PROXY_QUARANTINED', options.requestId, 'Proxy is quarantined.'));
		}
		if (this.pending.length >= this.maxPendingRequests) {
			return Promise.reject(this.rejection('PROXY_OVERLOADED', options.requestId, 'Proxy admission queue is full.'));
		}
		if (options.signal?.aborted) return Promise.reject(new ClientDisconnectedError());

		return new Promise<T>((resolve, reject) => {
			const entry: PendingEntry = {
				...options,
				resolve: value => resolve(value as T),
				reject,
				timer: setTimeout(() => {
					if (!this.removePending(entry)) return;
					reject(this.rejection('PROXY_QUEUE_TIMEOUT', options.requestId, 'Proxy admission queue timed out.'));
					this.onStateChange();
				}, this.queueTimeout),
			};
			entry.timer.unref?.();
			if (options.signal) {
				entry.onAbort = () => {
					if (!this.removePending(entry)) return;
					clearTimeout(entry.timer);
					reject(new ClientDisconnectedError());
					this.onStateChange();
				};
				options.signal.addEventListener('abort', entry.onAbort, { once: true });
			}
			this.pending.push(entry);
			this.onStateChange();
			this.pump();
		});
	}

	private removePending(entry: PendingEntry): boolean {
		const index = this.pending.indexOf(entry);
		if (index === -1) return false;
		this.pending.splice(index, 1);
		this.detach(entry);
		return true;
	}

	private detach(entry: PendingEntry): void {
		clearTimeout(entry.timer);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
	}

	private pump(): void {
		if (!this.accepting || this.tokenQuarantined || this.invalidBudget.blockedFor(Date.now()) > 0) return;
		while (this.pending.length) {
			const entry = this.pending[0];
			if (entry.signal?.aborted) {
				this.pending.shift();
				this.detach(entry);
				entry.reject(new ClientDisconnectedError());
				continue;
			}
			const now = Date.now();
			const delay = entry.exempt ? 0 : this.globalGate.delay(now);
			if (delay > 0) {
				this.schedulePump(delay);
				break;
			}
			this.pending.shift();
			this.detach(entry);
			if (!entry.exempt) this.globalGate.record(now);
			this.dispatch(entry);
		}
		this.onStateChange();
	}

	private schedulePump(delay: number): void {
		if (this.gateTimer) clearTimeout(this.gateTimer);
		this.gateTimer = setTimeout(() => {
			this.gateTimer = undefined;
			this.onStateChange();
			this.pump();
		}, delay);
		this.gateTimer.unref?.();
	}

	private dispatch(entry: PendingEntry): void {
		this.inFlightIds.add(entry.requestId);
		this.onStateChange();
		entry
			.run()
			.then(entry.resolve, entry.reject)
			.finally(() => {
				this.inFlightIds.delete(entry.requestId);
				this.onStateChange();
			});
	}

	private rejectPending(code: ProxyErrorCode, message: string): void {
		for (const entry of this.pending.splice(0)) {
			this.detach(entry);
			entry.reject(this.rejection(code, entry.requestId, message));
		}
	}

	startDraining(): void {
		if (!this.accepting) return;
		this.accepting = false;
		if (this.gateTimer) clearTimeout(this.gateTimer);
		this.gateTimer = undefined;
		this.rejectPending('PROXY_DRAINING', 'Proxy is draining.');
		this.onStateChange();
	}
}
