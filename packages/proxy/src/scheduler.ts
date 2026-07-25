import type { RestContext } from './contexts';
import { SlidingWindow } from './gates';
import { ProxyError, type ProxyErrorCode, type ProxyPhase, proxyError } from './protocol';

interface PendingEntry {
	operationId: symbol;
	requestId: string;
	context: RestContext;
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: ProxyError | ClientDisconnectedError) => void;
	timer?: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface AdmissionReservation {
	readonly operationId: symbol;
}

export interface InFlightRequest extends AdmissionReservation {
	readonly requestId: string;
	readonly contextKey: string;
}

export interface SubmitOptions<T> {
	requestId: string;
	context: RestContext;
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
	private readonly inFlightRequests = new Map<symbol, { requestId: string; contextKey: string }>();
	private readonly quarantinedContexts = new Set<string>();
	private gateTimer?: NodeJS.Timeout;
	private notifyInvalidRecoveryOnPump = false;
	private accepting = true;

	constructor(
		private readonly maxAdmittedRequests: number,
		private readonly queueTimeout: number,
		readonly invalidBudget: SlidingWindow,
		private readonly notifyLifecycleChange: () => void,
	) {}

	get pendingCount(): number {
		return this.pending.length + this.reservations.size;
	}

	get admittedCount(): number {
		return this.pendingCount + this.inFlightRequests.size;
	}

	get inFlightCount(): number {
		return this.inFlightRequests.size;
	}

	get inFlight(): readonly InFlightRequest[] {
		return [...this.inFlightRequests].map(([operationId, request]) => ({ operationId, ...request }));
	}

	get draining(): boolean {
		return !this.accepting;
	}

	get invalidBudgetExhausted(): boolean {
		return this.invalidBudget.blockedFor(Date.now()) > 0;
	}

	private rejection(
		code: ProxyErrorCode,
		requestId: string,
		message: string,
		phase: ProxyPhase = 'admission',
	): ProxyError {
		return new ProxyError(proxyError(code, 'not_dispatched', requestId, message, phase));
	}

	reserve(requestId: string): AdmissionReservation {
		if (!this.accepting) throw this.rejection('PROXY_DRAINING', requestId, 'Proxy is draining.', 'drain');
		if (this.invalidBudgetExhausted) {
			throw this.rejection(
				'PROXY_INVALID_REQUEST_BUDGET_EXHAUSTED',
				requestId,
				'The shared invalid-request budget is exhausted.',
			);
		}
		if (this.admittedCount >= this.maxAdmittedRequests) {
			throw this.rejection('PROXY_OVERLOADED', requestId, 'Proxy admission capacity is full.');
		}
		const reservation = { operationId: Symbol(requestId) };
		this.reservations.add(reservation.operationId);
		return reservation;
	}

	releaseReservation(reservation: AdmissionReservation): void {
		this.reservations.delete(reservation.operationId);
	}

	submitReserved<T>(reservation: AdmissionReservation, options: SubmitOptions<T>): Promise<T> {
		if (!this.reservations.delete(reservation.operationId)) {
			return Promise.reject(
				this.rejection(
					'PROXY_INTERNAL',
					options.requestId,
					'Proxy admission reservation is no longer active.',
					'internal',
				),
			);
		}
		if (this.quarantinedContexts.has(options.context.key)) {
			return Promise.reject(
				this.rejection('PROXY_TOKEN_REJECTED', options.requestId, 'The selected token version is quarantined.'),
			);
		}
		return this.enqueue(options, reservation.operationId);
	}

	private enqueue<T>(options: SubmitOptions<T>, operationId: symbol): Promise<T> {
		if (options.signal?.aborted) return Promise.reject(new ClientDisconnectedError());
		return new Promise<T>((resolve, reject) => {
			const entry: PendingEntry = {
				...options,
				operationId,
				resolve: value => resolve(value as T),
				reject,
			};
			entry.timer = setTimeout(() => {
				if (!this.removePending(entry)) return;
				reject(this.rejection('PROXY_QUEUE_TIMEOUT', options.requestId, 'Proxy admission queue timed out.'));
			}, this.queueTimeout);
			entry.timer.unref();
			if (options.signal) {
				entry.onAbort = () => {
					if (!this.removePending(entry)) return;
					reject(new ClientDisconnectedError());
				};
				options.signal.addEventListener('abort', entry.onAbort, { once: true });
			}
			this.pending.push(entry);
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
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
	}

	private pump(): void {
		const invalidDelay = this.invalidBudget.blockedFor(Date.now());
		if (invalidDelay > 0) {
			this.schedulePump(invalidDelay, true);
			return;
		}
		while (this.pending.length) {
			const now = Date.now();
			// Preserve FIFO within each context while allowing another context to pass a blocked head.
			const seenContexts = new Set<string>();
			let selectedIndex = -1;
			let nextDelay = Number.POSITIVE_INFINITY;

			for (let index = 0; index < this.pending.length; index++) {
				const entry = this.pending[index];
				if (entry.signal?.aborted) {
					this.pending.splice(index, 1);
					index--;
					this.detach(entry);
					entry.reject(new ClientDisconnectedError());
					continue;
				}
				if (this.quarantinedContexts.has(entry.context.key)) {
					this.pending.splice(index, 1);
					index--;
					this.detach(entry);
					entry.reject(
						this.rejection('PROXY_TOKEN_REJECTED', entry.requestId, 'The selected token version is quarantined.'),
					);
					continue;
				}
				if (seenContexts.has(entry.context.key)) continue;
				seenContexts.add(entry.context.key);
				const delay = entry.context.gate.blockedFor(now);
				if (delay === 0) {
					selectedIndex = index;
					break;
				}
				nextDelay = Math.min(nextDelay, delay);
			}

			if (selectedIndex === -1) {
				if (Number.isFinite(nextDelay)) this.schedulePump(nextDelay);
				break;
			}
			const [entry] = this.pending.splice(selectedIndex, 1);
			this.detach(entry);
			entry.context.gate.record(now);
			this.dispatch(entry);
		}
	}

	private schedulePump(delay: number, notifyInvalidRecovery = false): void {
		if (delay <= 0) return;
		this.notifyInvalidRecoveryOnPump ||= notifyInvalidRecovery;
		if (this.gateTimer) clearTimeout(this.gateTimer);
		this.gateTimer = setTimeout(() => {
			const shouldNotifyInvalidRecovery = this.notifyInvalidRecoveryOnPump;
			this.notifyInvalidRecoveryOnPump = false;
			this.gateTimer = undefined;
			this.pump();
			if (shouldNotifyInvalidRecovery && !this.invalidBudgetExhausted) this.notifyLifecycleChange();
		}, delay);
		this.gateTimer.unref();
	}

	private dispatch(entry: PendingEntry): void {
		this.inFlightRequests.set(entry.operationId, {
			requestId: entry.requestId,
			contextKey: entry.context.key,
		});
		entry
			.run()
			.then(entry.resolve, entry.reject)
			.finally(() => {
				this.inFlightRequests.delete(entry.operationId);
			});
	}

	recordInvalid(now = Date.now()): void {
		const wasExhausted = this.invalidBudget.blockedFor(now) > 0;
		this.invalidBudget.record(now);
		const delay = this.invalidBudget.blockedFor(now);
		if (delay > 0) this.schedulePump(delay, true);
		if (!wasExhausted && delay > 0) this.notifyLifecycleChange();
	}

	quarantineContext(contextKey: string): void {
		if (this.quarantinedContexts.has(contextKey)) return;
		this.quarantinedContexts.add(contextKey);
		for (const entry of [...this.pending]) {
			if (entry.context.key !== contextKey || !this.removePending(entry)) continue;
			entry.reject(
				this.rejection('PROXY_TOKEN_REJECTED', entry.requestId, 'The selected token version is quarantined.'),
			);
		}
		this.notifyLifecycleChange();
	}

	startDraining(): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.notifyLifecycleChange();
		this.pump();
	}

	rejectPendingForDrain(): void {
		for (const entry of this.pending.splice(0)) {
			this.detach(entry);
			entry.reject(this.rejection('PROXY_DRAINING', entry.requestId, 'Proxy drain timeout expired.', 'drain'));
		}
	}
}
