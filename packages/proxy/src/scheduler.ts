import { InvalidRequestBudget, SlidingWindow } from './gates';
import { ProxyError, type ProxyErrorCode, proxyError } from './protocol';

interface PendingEntry {
	operationId: symbol;
	requestId: string;
	exempt: boolean;
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: ProxyError | ClientDisconnectedError) => void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface AdmissionReservation {
	readonly operationId: symbol;
}

export interface InFlightRequest extends AdmissionReservation {
	readonly requestId: string;
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
	private readonly reservations = new Set<symbol>();
	private readonly inFlightRequests = new Map<symbol, string>();
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
		return this.pending.length + this.reservations.size;
	}

	get inFlightCount(): number {
		return this.inFlightRequests.size;
	}

	get inFlight(): readonly InFlightRequest[] {
		return [...this.inFlightRequests].map(([operationId, requestId]) => ({ operationId, requestId }));
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

	reserve(requestId: string): AdmissionReservation {
		if (!this.accepting) throw this.rejection('PROXY_DRAINING', requestId, 'Proxy is draining.');
		if (this.quarantined) throw this.rejection('PROXY_QUARANTINED', requestId, 'Proxy is quarantined.');
		if (this.pendingCount >= this.maxPendingRequests) {
			throw this.rejection('PROXY_OVERLOADED', requestId, 'Proxy admission queue is full.');
		}
		const reservation = { operationId: Symbol(requestId) };
		this.reservations.add(reservation.operationId);
		this.onStateChange();
		return reservation;
	}

	releaseReservation(reservation: AdmissionReservation): void {
		if (!this.reservations.delete(reservation.operationId)) return;
		this.onStateChange();
	}

	submit<T>(options: SubmitOptions<T>): Promise<T> {
		return this.enqueue(options, Symbol(options.requestId), false);
	}

	submitReserved<T>(reservation: AdmissionReservation, options: SubmitOptions<T>): Promise<T> {
		if (!this.reservations.delete(reservation.operationId)) {
			return Promise.reject(
				this.rejection('PROXY_INTERNAL', options.requestId, 'Proxy admission reservation is no longer active.'),
			);
		}
		this.onStateChange();
		return this.enqueue(options, reservation.operationId, true);
	}

	private enqueue<T>(options: SubmitOptions<T>, operationId: symbol, reserved: boolean): Promise<T> {
		if (!this.accepting) {
			return Promise.reject(this.rejection('PROXY_DRAINING', options.requestId, 'Proxy is draining.'));
		}
		if (this.quarantined) {
			return Promise.reject(this.rejection('PROXY_QUARANTINED', options.requestId, 'Proxy is quarantined.'));
		}
		if (!reserved && this.pendingCount >= this.maxPendingRequests) {
			return Promise.reject(this.rejection('PROXY_OVERLOADED', options.requestId, 'Proxy admission queue is full.'));
		}
		if (options.signal?.aborted) return Promise.reject(new ClientDisconnectedError());

		return new Promise<T>((resolve, reject) => {
			const entry: PendingEntry = {
				...options,
				operationId,
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
			let index = 0;
			let entry = this.pending[index];
			if (entry.signal?.aborted) {
				this.pending.splice(index, 1);
				this.detach(entry);
				entry.reject(new ClientDisconnectedError());
				continue;
			}
			const now = Date.now();
			const delay = entry.exempt ? 0 : this.globalGate.delay(now);
			if (delay > 0) {
				index = this.pending.findIndex(candidate => candidate.exempt);
				if (index === -1) {
					this.schedulePump(delay);
					break;
				}
				entry = this.pending[index];
			}
			if (entry.signal?.aborted) {
				this.pending.splice(index, 1);
				this.detach(entry);
				entry.reject(new ClientDisconnectedError());
				continue;
			}
			this.pending.splice(index, 1);
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
		this.inFlightRequests.set(entry.operationId, entry.requestId);
		this.onStateChange();
		entry
			.run()
			.then(entry.resolve, entry.reject)
			.finally(() => {
				this.inFlightRequests.delete(entry.operationId);
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
