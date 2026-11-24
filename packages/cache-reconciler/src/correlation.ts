/**
 * Links what the Gateway interceptor captured for a packet to the callback Seyfert runs after its core cache
 * mutation.
 *
 * Seyfert hands a plugin cache resource the `d` reference returned by the last interceptor, but it drops `s` and
 * the shard id on the way. Payload identity is therefore the exact path. The structured key only covers an
 * interceptor that swaps the payload after this plugin observed the end of the chain, and it never guesses
 * between two pending packets.
 *
 * @internal
 */
export class PacketCorrelation<T extends object> {
	private readonly byPayload = new WeakMap<object, T>();
	private readonly byKey = new Map<string, Map<string, T[]>>();

	track(payload: unknown, event: string, entity: string, entry: T): void {
		this.retarget(payload, entry);
		let entities = this.byKey.get(event);
		if (!entities) {
			entities = new Map();
			this.byKey.set(event, entities);
		}
		const pending = entities.get(entity);
		if (pending) pending.push(entry);
		else entities.set(entity, [entry]);
	}

	/** Follows an interceptor that replaced or cloned the payload after it was tracked. */
	retarget(payload: unknown, entry: T): void {
		if (typeof payload === 'object' && payload !== null) this.byPayload.set(payload, entry);
	}

	/**
	 * Returns the entry tracked for this exact payload, or the only pending entry for the event and entity.
	 * Completion order says nothing about which packet finished, so several pending entries resolve to nothing.
	 */
	resolve(payload: unknown, event: string, entity: string): T | undefined {
		if (typeof payload === 'object' && payload !== null) {
			const exact = this.byPayload.get(payload);
			if (exact) return exact;
		}
		const pending = this.byKey.get(event)?.get(entity);
		return pending?.length === 1 ? pending[0] : undefined;
	}

	/** Pending entries that `resolve` refused to choose between; the caller must fail them closed. */
	ambiguous(event: string, entity: string): T[] {
		const pending = this.byKey.get(event)?.get(entity);
		return pending && pending.length > 1 ? [...pending] : [];
	}

	release(event: string, entity: string, entry: T): void {
		const entities = this.byKey.get(event);
		const pending = entities?.get(entity);
		if (!entities || !pending) return;
		const index = pending.indexOf(entry);
		if (index !== -1) pending.splice(index, 1);
		if (!pending.length) entities.delete(entity);
		if (!entities.size) this.byKey.delete(event);
	}
}
