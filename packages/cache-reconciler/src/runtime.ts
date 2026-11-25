import { type Adapter, type SeyfertPluginApi, WorkerAdapter, WorkerClient } from 'seyfert';
import { ReconciledAdapter } from './adapter';
import type { CacheReconcilerCoordinator } from './coordinator';
import { KeyLayout } from './keys';
import { ReconciliationState } from './state';

const PLUGIN_NAME = '@slipher/cache-reconciler';

/** Whether this plugin's wrapper still owns `client.cache.adapter`. */
export type CacheReconcilerAdapterStatus = 'pending' | 'installed' | 'replaced' | 'restored';

export interface CacheReconcilerStatus {
	coordinator: CacheReconcilerCoordinator['kind'];
	/**
	 * `replaced` means another owner assigned `client.cache.adapter` after setup. Cache traffic then bypasses
	 * reconciliation and this plugin leaves the newer adapter in place. The check runs when status is read and
	 * when the client closes.
	 */
	adapter: CacheReconcilerAdapterStatus;
}

interface CacheClient {
	cache: { adapter: Adapter };
	applicationId?: string;
}

type Diagnostics = Pick<SeyfertPluginApi['diagnostics'], 'warn'>;

/**
 * Owns the installation for one plugin instance. It stays inside the plugin closure: `client.cacheReconciler`
 * only reaches it through the read-only manager.
 *
 * @internal
 */
export class ReconcilerRuntime {
	private original: Adapter | undefined;
	private wrapper: ReconciledAdapter | undefined;
	private adapterStatus: CacheReconcilerAdapterStatus = 'pending';
	private client: CacheClient | undefined;
	private diagnostics: Diagnostics | undefined;
	private readonly state = new ReconciliationState();

	constructor(private readonly coordinator: CacheReconcilerCoordinator) {}

	status(): CacheReconcilerStatus {
		this.checkOwnership();
		return { coordinator: this.coordinator.kind, adapter: this.adapterStatus };
	}

	async waitForIdle(): Promise<void> {}

	install(client: CacheClient, diagnostics?: Diagnostics): void {
		const original = client.cache.adapter;
		assertSupportedClient(client, original);
		const layout = new KeyLayout(() => client.applicationId || undefined);
		const binding = this.coordinator.bind({ inner: original, state: this.state, layout });
		const wrapper = new ReconciledAdapter(original, { state: this.state, layout, binding });
		this.original = original;
		this.client = client;
		this.diagnostics = diagnostics;
		// Assignment stays last: Seyfert does not run teardown for a plugin whose own setup throws.
		this.wrapper = wrapper;
		client.cache.adapter = wrapper;
		this.adapterStatus = 'installed';
	}

	uninstall(client: CacheClient): void {
		this.checkOwnership();
		if (this.wrapper && this.original && client.cache.adapter === this.wrapper) {
			client.cache.adapter = this.original;
			this.adapterStatus = 'restored';
		}
		this.original = undefined;
		this.wrapper = undefined;
		this.client = undefined;
	}

	private checkOwnership(): void {
		if (this.adapterStatus !== 'installed' || !this.client || this.client.cache.adapter === this.wrapper) return;
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
