import {
	type Adapter,
	BaseResource,
	type Cache,
	type GatewayDispatchPayload,
	PluginOrder,
	type SeyfertPluginApi,
	SeyfertPluginError,
	WorkerAdapter,
	WorkerClient,
} from 'seyfert';
import { ReconciledAdapter } from './adapter';
import type { BoundCoordinator, CacheReconcilerCoordinator, CoordinatorBinding } from './coordinator';
import { PacketCorrelation } from './correlation';
import { ReconciliationEngine } from './engine';
import { KeyLayout } from './keys';
import { type GuildSnapshotPlan, planGuildSnapshot } from './snapshot';
import { type GuildOutcome, type GuildWork, ReconciliationState, type StateSnapshot } from './state';
import { isThenable } from './sync';

const PLUGIN_NAME = '@slipher/cache-reconciler';
const PROBE_EVENT = `${PLUGIN_NAME}:probe`;

type DispatchInterceptor = Parameters<SeyfertPluginApi['gateway']['onDispatch']>[0];
type DispatchNext = Parameters<DispatchInterceptor>[1];
type DispatchClient = Parameters<DispatchInterceptor>[2]['client'];

/** Whether this plugin's wrapper still owns `client.cache.adapter`. */
export type CacheReconcilerAdapterStatus = 'pending' | 'installed' | 'replaced' | 'restored';

export interface CacheReconcilerStatus extends StateSnapshot {
	coordinator: CacheReconcilerCoordinator['kind'];
	/**
	 * `replaced` means another owner assigned `client.cache.adapter` after setup. Unless that adapter delegates
	 * to this plugin's, cache traffic bypasses reconciliation; either way this plugin leaves the newer adapter
	 * in place. The check runs on every observed Gateway packet, when status is read, and when the client closes.
	 */
	adapter: CacheReconcilerAdapterStatus;
}

interface CacheClient {
	cache: Cache;
	applicationId?: string;
}

/** Guild work together with what the interceptor captured for it. */
interface TrackedWork {
	readonly work: GuildWork;
	/** Gateway event that registered the work; part of the structured correlation key. */
	readonly event: string;
	/** What a startup snapshot lists, read from the payload the interceptor chain handed to Seyfert. */
	plan: GuildSnapshotPlan | undefined;
	/** Set once the interceptor chain handed the packet to Seyfert for caching. */
	dispatched: boolean;
}

/** One setup of the plugin on a client. */
interface Installation {
	readonly client: CacheClient;
	readonly original: Adapter;
	readonly wrapper: ReconciledAdapter;
	readonly binding: CoordinatorBinding;
	readonly layout: KeyLayout;
	readonly engine: ReconciliationEngine;
}

/** Gives the plugin a cache-resource slot, which is how Seyfert calls it back after its core cache mutation. */
class ReconcilerResource extends BaseResource {
	namespace = 'cache_reconciler';
}

/**
 * Owns one plugin instance: the installation, the Gateway bookkeeping, and the post-cache reconciliation.
 * It stays inside the plugin closure; `client.cacheReconciler` only reaches it through the read-only manager.
 *
 * @internal
 */
export class ReconcilerRuntime {
	private state = new ReconciliationState();
	/** Work registered by the interceptor and not settled yet, findable from the payload Seyfert caches. */
	private correlation = new PacketCorrelation<TrackedWork>();
	/** Errors of failed adapter mutations, which `mutationFailed` already accounted for. */
	private readonly attributed = new WeakSet<object>();
	/** `false` once the probe completed and Seyfert never called the cache resource back. */
	private observerAlive: boolean | undefined;
	private installation: Installation | undefined;
	private adapterStatus: CacheReconcilerAdapterStatus = 'pending';
	private diagnostics: Pick<SeyfertPluginApi['diagnostics'], 'warn'> | undefined;

	constructor(private readonly coordinator: BoundCoordinator) {}

	status(): CacheReconcilerStatus {
		this.checkOwnership();
		return { coordinator: this.coordinator.kind, adapter: this.adapterStatus, ...this.state.snapshot() };
	}

	waitForIdle(): Promise<void> {
		return this.state.whenIdle();
	}

	/** Contributes the Gateway interceptor and the post-cache observer. Both stay inert until the adapter started. */
	register(api: SeyfertPluginApi): void {
		this.diagnostics = api.diagnostics;
		api.gateway.addIntents('Guilds');
		// Before every other plugin: a packet another interceptor drops later is still observed and settled.
		api.gateway.onDispatch((packet, next, meta) => this.intercept(packet, next, meta.shardId, meta.client), {
			order: PluginOrder.Before,
		});
		api.cache.resource('cacheReconcilerObserver', ReconcilerResource, {
			onPacket: event => this.afterCoreCache(event),
		});
		api.events.onError((error, name) => this.eventFailed(error, name));
		api.hooks.on('plugins:ready', client => this.probeObserver(client.cache));
	}

	install(client: CacheClient): void {
		if (this.installation) {
			// Seyfert tears a plugin down when a later plugin's setup fails and lets the caller retry start().
			// That is safe to follow while the wrapped adapter was never started; afterwards the instance is spent.
			if (this.state.lifecycle !== 'closed' || this.installation.wrapper.startAttempted) {
				throw new Error(
					`${PLUGIN_NAME} cannot be set up again: this instance is already ${this.state.lifecycle === 'installing' ? 'installed' : this.state.lifecycle}. Create a new client, adapter, and cacheReconciler() instance.`,
				);
			}
			this.state = new ReconciliationState();
			this.correlation = new PacketCorrelation();
			this.installation = undefined;
			this.adapterStatus = 'pending';
		}
		const original = client.cache.adapter;
		assertSupportedClient(client, original);
		const layout = new KeyLayout(() => client.applicationId || undefined);
		const binding = this.coordinator.bind({
			inner: original,
			state: this.state,
			layout,
			mutationFailed: (keys, cause, guildIds) => this.mutationFailed(keys, cause, guildIds),
		});
		const wrapper = new ReconciledAdapter(original, {
			state: this.state,
			layout,
			binding,
			beforeStart: () => this.assertObserver(),
		});
		const engine = new ReconciliationEngine({ cache: client.cache, wrapper, binding, layout, state: this.state });
		this.installation = { client, original, wrapper, binding, layout, engine };
		// Assignment stays last: Seyfert does not run teardown for a plugin whose own setup throws, so nothing
		// that can fail may follow it.
		client.cache.adapter = wrapper;
		this.adapterStatus = 'installed';
	}

	/**
	 * Stops admitting work, lets running sweeps finish without authorizing another delete, releases what the
	 * coordinator holds, and restores the original adapter only if the wrapper still owns the slot.
	 */
	async uninstall(client: CacheClient): Promise<void> {
		this.checkOwnership();
		const state = this.state;
		state.beginClose();
		this.prune();
		try {
			await state.whenIdle();
			await this.installation?.binding.close();
		} finally {
			if (this.installation && client.cache.adapter === this.installation.wrapper) {
				client.cache.adapter = this.installation.original;
				this.adapterStatus = 'restored';
			}
			state.close();
		}
	}

	// Gateway

	/**
	 * Captures what a packet means before Seyfert's cache drops `s` and the shard. It performs no I/O and never
	 * lets its own bookkeeping break the dispatch: a packet it does not track continues untouched.
	 */
	private intercept(
		packet: GatewayDispatchPayload,
		next: DispatchNext,
		shardId: number,
		client: DispatchClient,
	): ReturnType<DispatchInterceptor> {
		let tracked: TrackedWork | undefined;
		try {
			tracked = this.observe(packet, shardId, client);
		} catch (cause) {
			this.state.recordFailure({
				kind: 'observation',
				message: `Bookkeeping for ${packet.t} failed; the packet continues unobserved.`,
				shardId,
				cause,
			});
		}
		// Returning without calling next() lets Seyfert run the rest of the chain with the same packet.
		if (!tracked) return;
		return this.follow(tracked, packet, next, shardId, client);
	}

	/**
	 * Follows registered work through the rest of the interceptor chain. `next()` does not wrap core cache
	 * processing; it only tells whether Seyfert will cache the packet at all, and with which payload.
	 */
	private async follow(
		tracked: TrackedWork,
		packet: GatewayDispatchPayload,
		next: DispatchNext,
		shardId: number,
		client: DispatchClient,
	): Promise<void> {
		let final: GatewayDispatchPayload | null;
		try {
			final = await next();
		} catch (error) {
			this.abandon(tracked, 'A later Gateway interceptor rejected the packet, so Seyfert never cached it.', error);
			throw error;
		}
		try {
			if (final === null) {
				this.abandon(tracked, 'A later Gateway interceptor vetoed the packet, so Seyfert never cached it.');
			} else if (this.suspendIfInactive(shardId, client)) {
				// Suspending the shard already cancelled the work.
			} else if (final.t !== packet.t || guildOf(final) !== tracked.work.guildId) {
				this.abandon(tracked, 'A later Gateway interceptor replaced the packet with a different event or guild.');
			} else {
				// A later interceptor may have cloned or changed the payload; Seyfert caches the one it returned.
				const payload = payloadOf(final);
				if (tracked.work.kind === 'snapshot' && typeof payload === 'object' && payload !== null) {
					tracked.plan = planGuildSnapshot(tracked.work.guildId, payload);
				}
				this.correlation.retarget(payload, tracked);
				tracked.dispatched = true;
			}
		} catch (cause) {
			this.state.recordFailure({
				kind: 'observation',
				message: `Bookkeeping for ${packet.t} failed after the interceptor chain.`,
				shardId,
				cause,
			});
		}
	}

	private observe(packet: GatewayDispatchPayload, shardId: number, client: DispatchClient): TrackedWork | undefined {
		if (!this.state.admits) return;
		this.checkOwnership();
		if (this.suspendIfInactive(shardId, client)) return;
		switch (packet.t) {
			case 'READY':
				this.state.ready(
					shardId,
					packet.d.session_id,
					packet.d.shard?.[1] ?? 1,
					packet.d.guilds.map(guild => guild.id),
					packet.s,
				);
				this.prune();
				return;
			case 'RESUMED':
				if (!this.state.resumed(shardId)) {
					this.state.recordFailure({
						kind: 'session',
						message:
							'RESUMED arrived for a shard this instance holds no validated generation for; its guilds stay unreadable until the next READY.',
						shardId,
					});
				}
				return;
			case 'RAW_GUILD_CREATE':
			case 'GUILD_CREATE':
				return this.track(
					packet,
					this.state.guildAvailable(shardId, packet.d.id, packet.s, {
						startup: packet.t === 'RAW_GUILD_CREATE',
						unavailable: packet.d.unavailable === true,
					}),
				);
			case 'RAW_GUILD_DELETE':
			case 'GUILD_DELETE':
				return this.track(
					packet,
					this.state.guildGone(shardId, packet.d.id, packet.s, {
						startup: packet.t === 'RAW_GUILD_DELETE',
						unavailable: packet.d.unavailable === true,
					}),
				);
			case 'GUILDS_READY':
				this.startupCommitted(this.state.guildsReady(shardId));
				return;
			default:
				this.state.observe(shardId, packet.s);
				return;
		}
	}

	/**
	 * A worker that a hot reload stopped still receives packets, but Seyfert no longer applies them to a cache
	 * it does not recognize by identity. Whatever this instance recorded for the shard goes stale from then on,
	 * so the shard fails closed until its next READY.
	 */
	private suspendIfInactive(shardId: number, client: DispatchClient): boolean {
		if (!(client instanceof WorkerClient) || client.hotReloadState === 'active') return false;
		if (this.state.suspend(shardId)) {
			this.prune();
			this.state.recordFailure({
				kind: 'session',
				message:
					'This worker is not the active dispatcher, so Seyfert stopped applying Gateway packets to its cache; the shard stays unreadable until its next READY.',
				shardId,
			});
		}
		return true;
	}

	private track(packet: { t: string; d: { id: string } }, work: GuildWork | undefined): TrackedWork | undefined {
		if (!work) return;
		const tracked: TrackedWork = { work, event: packet.t, plan: undefined, dispatched: false };
		this.correlation.track(packet.d, packet.t, work.guildId, tracked);
		return tracked;
	}

	/** Forgets the entries whose work the state already cancelled or settled. */
	private prune(): void {
		for (const tracked of this.correlation.pending()) {
			if (tracked.work.settled !== undefined) this.correlation.release(tracked.event, tracked.work.guildId, tracked);
		}
	}

	// After core cache

	/**
	 * Seyfert calls this after its core cache mutation for the packet. A failure is recorded before it is
	 * rethrown, so both status and Seyfert's own cache-resource logger see it.
	 */
	private afterCoreCache(event: GatewayDispatchPayload): void {
		const name: string = event.t;
		if (name === PROBE_EVENT) {
			this.observerAlive = true;
			return;
		}
		if (!this.state.admits) return;
		if (event.t === 'READY') {
			// The new generation hides the shard for this process already; other readers follow once it is published.
			const publishing = this.installation?.binding.publish();
			if (isThenable(publishing)) this.background(() => Promise.resolve(publishing));
			return;
		}
		if (event.t !== 'RAW_GUILD_CREATE' && event.t !== 'RAW_GUILD_DELETE' && event.t !== 'GUILD_DELETE') return;
		try {
			const guildId = event.d.id;
			const tracked = this.correlation.resolve(event.d, event.t, guildId);
			if (tracked) this.reconcile(tracked);
			else {
				// Completion order cannot tell overlapping packets apart once their payload identity is lost.
				for (const lost of this.correlation.ambiguous(event.t, guildId)) {
					this.abandon(
						lost,
						`Two ${event.t} packets for the guild overlapped after another plugin replaced their payloads.`,
					);
				}
			}
		} catch (cause) {
			this.state.recordFailure({ kind: 'observation', message: `Post-cache handling of ${name} failed.`, cause });
			throw cause;
		}
	}

	/**
	 * Seyfert cached the packet. The physical cleanup runs in the background: what it removes is already
	 * unreadable, and Seyfert awaits this callback before it runs the event's listeners.
	 */
	private reconcile(tracked: TrackedWork): void {
		const engine = this.installation?.engine;
		const { work, plan } = tracked;
		if (work.settled !== undefined || !engine) return;
		// An unavailable guild confirms nothing about its descendants; they stay as they are, unreadable.
		if (work.kind === 'unavailable') {
			this.finish(tracked, 'unavailable-preserved');
			return;
		}
		// The callback ran, so a later failure cannot be this packet's cache phase anymore.
		this.correlation.release(tracked.event, work.guildId, tracked);
		this.background(async () => {
			try {
				const outcome =
					work.kind === 'snapshot' && plan ? await engine.sweepSnapshot(work, plan) : await engine.removeGuild(work);
				if (outcome !== 'failed') this.finish(tracked, outcome);
				else this.abandon(tracked, 'Some stale entries of the guild could not be removed; they stay hidden.');
			} catch (cause) {
				this.abandon(
					tracked,
					`Reconciling the guild after ${tracked.event} failed; its stale entries stay hidden.`,
					cause,
				);
			}
		});
	}

	/** The startup snapshot of a shard is complete: guilds it never listed are stale. */
	private startupCommitted(generation: number | undefined): void {
		const engine = this.installation?.engine;
		if (generation === undefined || !engine) return;
		this.background(() => engine.sweepStaleGuilds(generation));
	}

	/**
	 * Runs cleanup as pending work, so `waitForIdle()` and teardown wait for it. It starts on a later microtask:
	 * the Gateway interceptor and the post-cache callback that schedule it never do the first read themselves.
	 */
	private background(run: () => Promise<void>): void {
		const done = this.state.beginTask();
		Promise.resolve()
			.then(run)
			.catch(cause => this.state.recordFailure({ kind: 'guild', message: 'Background cleanup failed.', cause }))
			.finally(done);
	}

	/**
	 * A caller's cache mutation failed. When it belongs to a guild packet Seyfert was caching, the post-cache
	 * callback will never run for that packet, so its work is settled here.
	 */
	private mutationFailed(
		keys: readonly string[],
		cause: unknown,
		guildIds: readonly (string | undefined)[] = [],
	): void {
		if (typeof cause === 'object' && cause !== null) this.attributed.add(cause);
		const waiting = this.correlation.pending().filter(tracked => tracked.dispatched);
		if (!waiting.length) return;
		const layout = this.installation?.layout;
		// Each guild the failed mutation touched, and whether it carried the guild record itself.
		const touched = new Map<string, boolean>();
		for (const guildId of guildIds) {
			if (guildId !== undefined) touched.set(guildId, false);
		}
		for (const key of keys) {
			const record = layout?.guildRecord(key);
			const guildId = record ?? layout?.guildOfKey(key) ?? this.state.guildOf(key);
			if (guildId !== undefined) touched.set(guildId, record !== undefined || touched.get(guildId) === true);
		}
		for (const tracked of waiting) {
			const record = touched.get(tracked.work.guildId);
			// A snapshot is only known to have failed when the write carrying its guild record failed.
			if (record === undefined || (tracked.work.kind !== 'delete' && !record)) continue;
			this.abandon(tracked, `Seyfert could not apply ${tracked.event} to the cache.`, cause);
			if (tracked.work.kind === 'delete') this.stopServing(tracked.work);
		}
	}

	/**
	 * Discord reported the guild as removed and Seyfert could not remove it, so what is left at least stops
	 * being served. It stays stored until the shard's next startup finds the guild missing from READY.
	 */
	private stopServing(work: GuildWork): void {
		const binding = this.installation?.binding;
		if (!binding) return;
		this.background(async () => {
			await binding.closeGuild(work.guildId, work.sequence);
		});
	}

	private abandon(tracked: TrackedWork, message: string, cause?: unknown): void {
		if (tracked.work.settled !== undefined) return;
		this.state.recordFailure({
			kind: 'guild',
			message,
			shardId: tracked.work.shardId,
			guildId: tracked.work.guildId,
			cause,
		});
		this.finish(tracked, 'failed');
	}

	private finish(tracked: TrackedWork, outcome: GuildOutcome): void {
		this.correlation.release(tracked.event, tracked.work.guildId, tracked);
		this.startupCommitted(this.state.settle(tracked.work, outcome));
	}

	/**
	 * Seyfert reported a failure while dispatching an event. A failed adapter mutation was settled by
	 * `mutationFailed`, and another plugin's listener fails after the cache phase. What is left may be a core
	 * cache failure that never reached the adapter. Nothing ties it to one packet, so it is only recorded: the
	 * guild it belongs to stays pending until its shard's next READY. Seyfert only reports here when the event
	 * has a listener; without one the failure rejects the dispatch instead.
	 */
	private eventFailed(error: unknown, name: string): void {
		if (!this.state.admits || this.attributed.has(error as object) || error instanceof SeyfertPluginError) return;
		const waiting = this.correlation.pending().filter(tracked => tracked.event === name && tracked.dispatched);
		if (!waiting.length) return;
		this.state.recordFailure({
			kind: 'dispatch',
			message: `Seyfert reported a failure while dispatching ${name} with ${waiting.length} guild packet(s) still being cached; a guild whose cache phase did not complete stays pending until the shard's next READY.`,
			cause: error,
		});
	}

	// Installation checks

	/**
	 * Sends a marker through Seyfert's cache packet path to learn whether plugin cache resources are called
	 * back. Seyfert offers no way to read `disabledCache`; other plugins' cache resources see the marker too.
	 */
	private async probeObserver(cache: { onPacket(event: GatewayDispatchPayload): Promise<void> }): Promise<void> {
		this.observerAlive = undefined;
		await cache.onPacket({ t: PROBE_EVENT, d: { plugin: PLUGIN_NAME } } as never);
		// Only a completed round trip without the callback proves the cache does not process packets.
		this.observerAlive ??= false;
	}

	private assertObserver(): void {
		if (this.observerAlive !== false) return;
		throw new TypeError(
			`${PLUGIN_NAME} needs Seyfert to process Gateway packets in the cache: with disabledCache.onPacket the plugin is never told when a guild snapshot was cached, so it could not reconcile anything.`,
		);
	}

	private checkOwnership(): void {
		const installation = this.installation;
		if (this.adapterStatus !== 'installed' || !installation) return;
		if (installation.client.cache.adapter === installation.wrapper) return;
		this.adapterStatus = 'replaced';
		this.diagnostics?.warn(
			`${PLUGIN_NAME} no longer owns client.cache.adapter: it was replaced after setup. Cache traffic bypasses reconciliation unless the new adapter delegates to the one it replaced.`,
			{ code: 'cache-reconciler-adapter-replaced', phase: 'runtime' },
		);
	}
}

function assertSupportedClient(client: CacheClient, adapter: Adapter): void {
	if (adapter instanceof WorkerAdapter) {
		throw new TypeError(
			`${PLUGIN_NAME} cannot wrap WorkerAdapter: the real store lives in the WorkerManager process and Seyfert resolves worker cache responses through the adapter instance installed on the client. Give each WorkerClient a real adapter instead.`,
		);
	}
	// A hot-reload replacement skips Seyfert's cache phase while on standby, and Seyfert only warms adapters it
	// recognizes by identity, so a wrapped replacement would take over with a cache it never populated.
	if (client instanceof WorkerClient && client.isHotReloadReplacement) {
		throw new TypeError(
			`${PLUGIN_NAME} does not support WorkerManager.hotReload replacement workers: a standby worker skips cache processing for its startup guild stream, so the replacement would activate without a reconciled snapshot.`,
		);
	}
}

function payloadOf(packet: GatewayDispatchPayload): unknown {
	return Reflect.get(packet, 'd');
}

function guildOf(packet: GatewayDispatchPayload): unknown {
	const payload = payloadOf(packet);
	return typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'id') : undefined;
}
