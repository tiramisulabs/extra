import type { Client } from 'seyfert';
import type { DispatchResult } from './bot';
import type { MockApiHandler, RecordedAction, RouteMatcher } from './rest';
import { modalRegistry } from './seyfert-internals';

export interface ModalWaiter {
	dispatchId: number;
	resolve: () => void;
	reject: (error: unknown) => void;
}

export interface ModalWaitRegistration {
	registered: Promise<void>;
	dispose(): void;
}

/** Lazy, step-able handle returned by every user-action dispatcher. */
export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
	private execution?: Promise<T>;
	private releasePending?: () => void;
	private settled = false;
	private completed = false;

	constructor(
		private readonly rest: MockApiHandler,
		private readonly clientRef: Client,
		readonly userId: string | undefined,
		private readonly executor: () => Promise<T>,
		/** Resolves when seyfert registers a modal for the given userId; supplied by MockBot. */
		private readonly modalWaiter?: (userId: string, dispatchId: number | undefined) => ModalWaitRegistration,
		/**
		 * This dispatch's id, so {@link until} can scope its gate to only this dispatch's recorded actions.
		 * Optional: a gate created without an id stays unscoped (matches any dispatch's actions).
		 */
		readonly dispatchId?: number,
		/** Submits a modal as this dispatch's user; supplied by MockBot so {@link fillModal} needs no bot handle. */
		private readonly modalFiller?: (customId: string, fields: Record<string, string>) => Dispatch<DispatchResult>,
		/** Clears same-user modal ownership after timeoutModal consumes the registry entry. */
		private readonly modalCleaner?: (userId: string) => void,
		/**
		 * Waits for the recorded action that renders a message bearing `customId` (event-driven, so it crosses
		 * non-REST gaps like a DB query), raced against this dispatch completing without it; supplied by MockBot
		 * so {@link untilComponent} needs no bot handle.
		 */
		private readonly componentAwaiter?: (
			customId: string,
			dispatchId: number | undefined,
			execution: Promise<unknown>,
			timeoutMs?: number,
		) => Promise<RecordedAction>,
	) {}

	private start(): Promise<T> {
		this.execution ??= this.executor().finally(() => {
			this.completed = true;
		});
		return this.execution;
	}

	get started(): boolean {
		return this.execution !== undefined;
	}

	get isSettled(): boolean {
		return this.settled;
	}

	get isCompleted(): boolean {
		return this.completed;
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
	 * Start this dispatch and resolve once it has rendered a message carrying `customId` — without awaiting the
	 * handler to completion. It drains the dispatch's pending async, so a handler that replies, attaches a
	 * collector, then parks on `collector.waitFor(...)` settles right up to the park instead of blocking the
	 * await for the full collector timeout. Read top-to-bottom afterwards: the dispatch is left in flight, so a
	 * source-less {@link MockBot.clickButton} resolves against that reply, and `await dispatch` settles the rest.
	 *
	 * ```ts
	 * const flow = bot.slash({ name: 'setup' });
	 * await flow.untilComponent('continue');   // reply sent, collector attached, handler parked
	 * await bot.clickButton('continue');        // drives the collector
	 * await flow;                               // handler resumes and returns
	 * ```
	 *
	 * The wait is event-driven, so it tolerates non-REST gaps (a DB query between `deferReply` and the reply).
	 * `timeoutMs` (default 5000) bounds how long to wait for the render; a handler that completes WITHOUT
	 * rendering fails immediately rather than waiting out the timeout.
	 */
	async untilComponent(customId: string, timeoutMs?: number): Promise<RecordedAction> {
		if (!this.componentAwaiter) {
			throw new TypeError('Dispatch.untilComponent: this dispatch type cannot render components.');
		}
		if (this.settled) {
			throw new TypeError(
				'Dispatch.untilComponent(): this dispatch already ran to completion - step with untilComponent() before awaiting it.',
			);
		}
		this.releaseCheckpoint();
		this.start();
		// The awaiting test owns the dispatch promise; swallow a late rejection so this step never unhandles it.
		this.execution!.catch(() => {});
		return this.componentAwaiter(customId, this.dispatchId, this.execution!, timeoutMs);
	}

	/**
	 * @internal Low-level primitive: resolve the instant seyfert registers a modal for this dispatch's user. Used
	 * by {@link fillModal} / {@link timeoutModal}, which are the supported one-call ways to drive a modal — prefer
	 * those. Awaited as an event (no wall-clock poll), so it works under frozen/fake timers; fails fast if the
	 * dispatch completes without opening a modal.
	 */
	async untilModal(): Promise<void> {
		if (!this.userId) {
			throw new TypeError('untilModal: this dispatch has no user - pass `user` to the dispatch options');
		}
		const userId = this.userId;
		this.releaseCheckpoint();
		this.start();
		const registration = this.modalWaiter?.(userId, this.dispatchId);
		const registered =
			registration?.registered ??
			(this.clientRef.components.modals.has(userId)
				? Promise.resolve()
				: // Fallback when no waiter hook was threaded: resolve only via the completion guard below.
					new Promise<void>(() => {}));
		try {
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
		} finally {
			registration?.dispose();
		}
	}

	/**
	 * Drive a modal opened by this dispatch in ONE call: it submits `customId`/`fields` as the opener's user and
	 * settles the opener so its post-`modal()` continuation (e.g. `submit.write(...)`) runs, returning the
	 * modal-submit result. The whole open → submit → settle handshake is internal; the user only writes this.
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

	/**
	 * Drive a modal opened by this dispatch to its TIMEOUT in ONE call: it resolves the opener's
	 * `interaction.modal({ waitFor })` with `null` — exactly as the real waitFor timer would on expiry, but
	 * instantly and with no fake-timer setup — so the handler runs its timeout branch, then returns the opener's
	 * result. The counterpart of {@link fillModal} for the "user never submitted" path.
	 */
	async timeoutModal(): Promise<T> {
		if (!this.userId) {
			throw new TypeError('Dispatch.timeoutModal: this dispatch has no user - pass `user` to the dispatch options.');
		}
		await this.untilModal();
		const userId = this.userId;
		const modals = modalRegistry(this.clientRef);
		const exec = modals.get(userId);
		modals.delete(userId);
		this.modalCleaner?.(userId);
		exec?.(null); // resolves modal({ waitFor }) with null -> the handler takes its timeout branch
		return await this;
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.releaseCheckpoint();
		this.settled = true;
		return this.start().then(onfulfilled, onrejected);
	}

	catch<TResult = never>(
		onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
	): Promise<T | TResult> {
		return this.then(undefined, onrejected);
	}

	finally(onfinally?: (() => void) | null): Promise<T> {
		this.releaseCheckpoint();
		this.settled = true;
		return this.start().finally(onfinally);
	}
}
