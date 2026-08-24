/** @internal */
export class ReadonlyMapView<Key, Value> implements ReadonlyMap<Key, Value> {
	readonly #source: Map<Key, Value>;

	constructor(source: Map<Key, Value>) {
		this.#source = source;
	}

	get size(): number {
		return this.#source.size;
	}

	get(key: Key): Value | undefined {
		return this.#source.get(key);
	}

	has(key: Key): boolean {
		return this.#source.has(key);
	}

	entries(): MapIterator<[Key, Value]> {
		return this.#source.entries();
	}

	keys(): MapIterator<Key> {
		return this.#source.keys();
	}

	values(): MapIterator<Value> {
		return this.#source.values();
	}

	forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#source) {
			callbackfn.call(thisArg, value, key, this);
		}
	}

	[Symbol.iterator](): MapIterator<[Key, Value]> {
		return this.entries();
	}

	get [Symbol.toStringTag](): string {
		return 'Map';
	}
}
