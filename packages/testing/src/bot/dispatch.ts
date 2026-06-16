import type { Client } from 'seyfert';
import type { DispatchResult } from './bot';
import type { MockApiHandler, RecordedAction, RouteMatcher } from './rest';

/** Lazy, step-able handle returned by every user-action dispatcher. */
export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
	private execution?: Promise<T>;
	private releasePending?: () => void;
	private settled = false;

	constructor(
		private readonly rest: MockApiHandler,
		private readonly clientRef: Client,
		readonly userId: string | undefined,
		private readonly executor: () => Promise<T>,
		/** Resolves when seyfert registers a modal for the given userId; supplied by MockBot. */
		private readonly modalWaiter?: (userId: string) => Promise<void>,
		/**
		 * This dispatch's id, so {@link until} can scope its gate to only this dispatch's recorded actions.
		 * Optional: a gate created without an id stays unscoped (matches any dispatch's actions).
		 */
		readonly dispatchId?: number,
		/** Submits a modal as this dispatch's user; supplied by MockBot so {@link fillModal} needs no bot handle. */
		private readonly modalFiller?: (
			customId: string,
			fields: Record<string, string>,
		) => Dispatch<DispatchResult>,
	) {}

	private start(): Promise<T> {
		this.execution ??= this.executor();
		return this.execution;
	}

	get started(): boolean {
		return this.execution !== undefined;
	}

	get isSettled(): boolean {
		return this.settled;
	}

	private releaseCheckpoint(): void {
		const release = this.releasePending;
		this.releasePending = undefined;
		release?.();
	}

	async until(matcher: RouteMatcher | ((action: RecordedAction) => boolean)): Promise<RecordedAction> {
		if (this.settled) {
			throw new TypeError(
				'Dispatch.until(): this dispatch already ran to completion - step with until() before awaiting it.',
			);
		}
		const gated = this.rest.gateNext(matcher, this.dispatchId);
		const previous = this.releasePending;
		this.releasePending = gated.release;
		this.start();
		previous?.();
		const failure = this.execution!.then(
			() => undefined,
			err => {
				throw err;
			},
		);
		this.execution!.catch(() => {});
		return Promise.race([gated.hit, failure.then(() => gated.hit)]);
	}

	/**
	 * Resolve the instant seyfert registers a modal for this dispatch's user (event-driven, no wall-clock poll),
	 * so it works under frozen/fake timers. Fails fast and deterministically if the dispatch runs to completion
	 * without ever opening a modal. `timeoutMs` is accepted for backward compatibility but ignored — registration
	 * is awaited as an event, not raced against a clock.
	 */
	async untilModal(_timeoutMs = 2000): Promise<void> {
		if (!this.userId) {
			throw new TypeError('untilModal: this dispatch has no user - pass `user` to the dispatch options');
		}
		const userId = this.userId;
		this.releaseCheckpoint();
		this.start();
		if (this.clientRef.components.modals.has(userId)) return;
		const registered = this.modalWaiter
			? this.modalWaiter(userId)
			: // Fallback when no waiter hook was threaded: resolve only via the completion guard below.
				new Promise<void>(() => {});
		// Swallow late rejection if `registered` wins the race; the awaiting test owns the dispatch promise.
		this.execution!.catch(() => {});
		await Promise.race([
			registered,
			this.execution!.then(() => {
				if (!this.clientRef.components.modals.has(userId)) {
					throw new Error(`untilModal: dispatch completed without opening a modal for user ${userId}.`);
				}
			}),
		]);
	}

	/**
	 * One-call modal flow: start this opener, wait for it to register a modal, submit `customId`/`fields` as the
	 * SAME user, then settle the opener so its post-`modal()` continuation (e.g. `submit.write(...)`) runs.
	 * Returns the modal-submit result. Replaces the manual
	 * `await d.untilModal(); await bot.fillModal(...); await d;` dance — the user is threaded for you.
	 */
	async fillModal(customId: string, fields: Record<string, string> = {}): Promise<DispatchResult> {
		if (!this.modalFiller) {
			throw new TypeError('Dispatch.fillModal: this dispatch type cannot open modals.');
		}
		await this.untilModal();
		const submit = await this.modalFiller(customId, fields);
		await this;
		return submit;
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.releaseCheckpoint();
		this.settled = true;
		return this.start().then(onfulfilled, onrejected);
	}
}
