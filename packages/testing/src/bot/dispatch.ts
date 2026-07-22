import type { Client } from 'seyfert';
import type { DispatchResult } from './bot';
import type { ModalFields } from './interactions';
import type { MockApiHandler, RecordedAction, RouteMatcher } from './rest';
import { modalRegistry } from './seyfert-internals';
import { type EmbedView, type InteractiveComponentView, renderedReply } from './state';

export interface ModalWaiter {
	dispatchId: number;
	resolve: () => void;
	reject: (error: unknown) => void;
}

export interface ModalWaitRegistration {
	registered: Promise<void>;
	dispose(): void;
}

export interface DispatchOptions<T> {
	rest: MockApiHandler;
	client: Client;
	userId?: string;
	/** This dispatch's id, used to scope recorded actions and stateful ownership. */
	dispatchId?: number;
	executor: () => Promise<T>;
	/** Resolves when seyfert registers a modal for the given userId; supplied by MockBot. */
	modalWaiter?: (userId: string, dispatchId: number | undefined) => ModalWaitRegistration;
	/** Submits a modal as this dispatch's user; supplied by MockBot so submitModal needs no bot handle. */
	modalFiller?: (customId: string, fields: ModalFields) => Dispatch<DispatchResult>;
	/** Clears same-user modal ownership after timeoutModal consumes the registry entry. */
	modalCleaner?: (userId: string) => void;
	/** Waits for a rendered component while racing the dispatch's completion. */
	componentAwaiter?: (
		customId: string,
		dispatchId: number | undefined,
		execution: Promise<unknown>,
		timeoutMs?: number,
	) => Promise<RecordedAction>;
	/** Builds the action's result from the output recorded so far when a stateful session yields at input. */
	snapshotter?: () => T;
}

/** Lazy, step-able handle exposed by the advanced `bot.dispatch.*` surface. */
export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
	private execution?: Promise<T>;
	private releasePending?: () => void;
	private settled = false;
	private completed = false;
	private readonly rest: MockApiHandler;
	private readonly clientRef: Client;
	readonly userId: string | undefined;
	readonly dispatchId: number | undefined;
	private readonly executor: () => Promise<T>;
	private readonly modalWaiter?: DispatchOptions<T>['modalWaiter'];
	private readonly modalFiller?: DispatchOptions<T>['modalFiller'];
	private readonly modalCleaner?: DispatchOptions<T>['modalCleaner'];
	private readonly componentAwaiter?: DispatchOptions<T>['componentAwaiter'];
	private readonly snapshotter?: DispatchOptions<T>['snapshotter'];

	constructor(options: DispatchOptions<T>) {
		this.rest = options.rest;
		this.clientRef = options.client;
		this.userId = options.userId;
		this.dispatchId = options.dispatchId;
		this.executor = options.executor;
		this.modalWaiter = options.modalWaiter;
		this.modalFiller = options.modalFiller;
		this.modalCleaner = options.modalCleaner;
		this.componentAwaiter = options.componentAwaiter;
		this.snapshotter = options.snapshotter;
	}

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

	/** @internal Start the raw handler without changing Dispatch's public completion semantics. */
	startForSession(): Promise<T> {
		return this.start();
	}

	/** @internal The already-started completion promise, used by the stateful session coordinator. */
	completionForSession(): Promise<T> | undefined {
		return this.execution;
	}

	/** @internal Build a partial result at a real input checkpoint. */
	snapshotForSession(): T {
		if (!this.snapshotter) {
			throw new TypeError('This dispatch cannot produce a result before its handler completes.');
		}
		return this.snapshotter();
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
	 * pass the returned action as the raw click's source, then `await dispatch` to settle the rest.
	 *
	 * ```ts
	 * const flow = bot.dispatch.slash({ name: 'setup' });
	 * const source = await flow.untilComponent('continue'); // handler parked
	 * await bot.dispatch.clickButton('continue', { source }); // drives the collector
	 * await flow; // handler resumes and returns
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
	 * What this dispatch has rendered so far — content + normalized embeds/components — read from its recorded
	 * REST actions. Works even while PARKED on a collector (not yet settled), so the accessors below can assert
	 * what a flow already produced without awaiting it.
	 */
	private rendered(): { content?: string; embeds: EmbedView[]; components: InteractiveComponentView[] } {
		return renderedReply(this.rest.actions, this.dispatchId);
	}

	/** Normalized embeds of this dispatch's latest reply; `rendered(flow)` reads the same parked-flow output. */
	lastEmbeds(): EmbedView[] {
		return this.rendered().embeds;
	}

	/** This dispatch's latest reply's embed at `index`; THROWS if it has rendered none or the index is out of range. */
	lastEmbed(index = 0): EmbedView {
		const embeds = this.rendered().embeds;
		if (embeds.length === 0) {
			throw new TypeError('Dispatch.lastEmbed: this dispatch has not rendered any embed yet.');
		}
		if (index < 0 || index >= embeds.length) {
			throw new TypeError(`Dispatch.lastEmbed: index ${index} is out of range — rendered ${embeds.length} embed(s).`);
		}
		return embeds[index];
	}

	/** Normalized components of this dispatch's latest reply; `rendered(flow)` reads the same parked-flow output. */
	lastComponents(): InteractiveComponentView[] {
		return this.rendered().components;
	}

	/**
	 * Best-effort latest text content this dispatch has rendered, or undefined if none. The text counterpart of
	 * {@link lastEmbeds}/{@link lastComponents}; works while PARKED, so a flow whose reply lands on a different token
	 * (e.g. an inline `await ctx.interaction.modal(...)` continuation that replies on the submit) is still readable.
	 */
	lastContent(): string | undefined {
		return this.rendered().content;
	}

	/**
	 * @internal Low-level primitive: resolve the instant seyfert registers a modal for this dispatch's user. Used
	 * by {@link submitModal} / {@link timeoutModal}, which are the supported one-call ways to drive a modal — prefer
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
	async submitModal(customId: string, fields: ModalFields = {}): Promise<DispatchResult> {
		if (!this.modalFiller) {
			throw new TypeError('Dispatch.submitModal: this dispatch type cannot open modals.');
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
	 * result. The counterpart of {@link submitModal} for the "user never submitted" path.
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

	/**
	 * Awaiting a dispatch resolves when the handler RETURNS (with its result) — not when detached background work
	 * settles. For background REST (DB writes, follow-up calls) the handler fire-and-forgets, add `await bot.settle()`;
	 * if the handler parks on a nested collector, await `untilComponent('id')` instead (awaiting this would hang).
	 */
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
