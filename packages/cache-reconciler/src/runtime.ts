import {
	type Adapter,
	BaseResource,
	type GatewayDispatchPayload,
	PluginOrder,
	type SeyfertPluginApi,
	SeyfertPluginError,
	WorkerAdapter,
	WorkerClient,
} from 'seyfert';
import { ReconciledAdapter } from './adapter';
import type { CacheReconcilerCoordinator, CoordinatorBinding } from './coordinator';
import { PacketCorrelation } from './correlation';
import { KeyLayout } from './keys';
import { type GuildOutcome, type GuildWork, ReconciliationState, type StateSnapshot } from './state';

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
	 * `replaced` means another owner assigned `client.cache.adapter` after setup. Cache traffic then bypasses
	 * reconciliation and this plugin leaves the newer adapter in place. The check runs on every observed
	 * Gateway packet, when status is read, and when the client closes.
	 */
	adapter: CacheReconcilerAdapterStatus;
}

interface CacheClient {
	cache: { adapter: Adapter };
	applicationId?: string;
}

/** Guild work together with what the interceptor captured for it. */
interface TrackedWork {
	readonly work: GuildWork;
	/** Gateway event that registered the work; part of the structured correlation key. */
	readonly event: string;
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

	constructor(private readonly coordinator: CacheReconcilerCoordinator) {}

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
			mutationFailed: (keys, cause) => this.mutationFailed(keys, cause),
		});
		const wrapper = new ReconciledAdapter(original, {
			state: this.state,
			layout,
			binding,
			beforeStart: () => this.assertObserver(),
		});
		this.installation = { client, original, wrapper, binding, layout };
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
				tracked.dispatched = true;
				// A later interceptor may have cloned the payload; Seyfert caches the one it returned.
				this.correlation.retarget(payloadOf(final), tracked);
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
				this.state.guildsReady(shardId);
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
		const tracked: TrackedWork = { work, event: packet.t, dispatched: false };
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

	private reconcile(tracked: TrackedWork): void {
		if (tracked.work.settled !== undefined) return;
		switch (tracked.work.kind) {
			case 'unavailable':
				this.finish(tracked, 'unavailable-preserved');
				return;
			case 'delete':
				// Core removes the guild record through the wrapper, which closes the partition; this covers a
				// client that does not cache guild records at all.
				this.state.closeGuild(tracked.work.guildId);
				this.finish(tracked, 'deleted');
				return;
			case 'snapshot':
				this.finish(tracked, 'reconciled');
				return;
		}
	}

	/**
	 * A caller's cache mutation failed. When it belongs to a guild packet Seyfert was caching, the post-cache
	 * callback will never run for that packet, so its work is settled here.
	 */
	private mutationFailed(keys: readonly string[], cause: unknown): void {
		if (typeof cause === 'object' && cause !== null) this.attributed.add(cause);
		const waiting = this.correlation.pending().filter(tracked => tracked.dispatched);
		if (!waiting.length) return;
		for (const key of keys) {
			const record = this.installation?.layout.guildRecord(key);
			const guildId = record ?? this.state.guildOf(key);
			if (guildId === undefined) continue;
			for (const tracked of waiting) {
				if (tracked.work.guildId !== guildId) continue;
				// A snapshot is only known to have failed when the write carrying its guild record failed.
				if (tracked.work.kind !== 'delete' && record === undefined) continue;
				this.abandon(tracked, `Seyfert could not apply ${tracked.event} to the cache.`, cause);
			}
		}
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
		this.state.settle(tracked.work, outcome);
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
			`${PLUGIN_NAME} no longer owns client.cache.adapter: it was replaced after setup, so cache traffic bypasses reconciliation.`,
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
