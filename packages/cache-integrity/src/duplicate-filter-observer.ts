interface DuplicateFilterPacket {
	readonly d: unknown;
	readonly t: 'GUILD_MEMBER_UPDATE' | 'PRESENCE_UPDATE';
}

interface InstalledCheckObserver {
	owned(): boolean;
	restore(): boolean;
}

function duplicateFilterHandler(client: object, property: 'memberUpdateHandler' | 'presenceUpdateHandler'): object {
	const handler = Reflect.get(client, property);
	if (!handler || typeof handler !== 'object') {
		throw new TypeError(`Seyfert client does not expose ${property}.`);
	}
	return handler;
}

/** @internal */
export interface DuplicateFilterObserver {
	owned(): boolean;
	restore(): boolean;
}

function installCheckObserver(
	getHandler: () => object,
	event: DuplicateFilterPacket['t'],
	onFiltered: (packet: DuplicateFilterPacket) => void,
): InstalledCheckObserver {
	const handler = getHandler();
	const originalDescriptor = Object.getOwnPropertyDescriptor(handler, 'check');
	const original = Reflect.get(handler, 'check');
	if (typeof original !== 'function') {
		throw new TypeError(`Seyfert ${event} duplicate filter does not expose check().`);
	}

	const wrapped = function (this: object, data: unknown): boolean {
		const admitted = Reflect.apply(original, this, [data]) as boolean;
		if (!admitted) onFiltered({ d: data, t: event });
		return admitted;
	};
	Object.defineProperty(handler, 'check', {
		configurable: true,
		value: wrapped,
		writable: true,
	});

	const owned = () => getHandler() === handler && Reflect.get(handler, 'check') === wrapped;
	return {
		owned,
		restore() {
			if (!owned()) return false;
			try {
				if (originalDescriptor) Object.defineProperty(handler, 'check', originalDescriptor);
				else if (!Reflect.deleteProperty(handler, 'check')) return false;
			} catch {
				return false;
			}
			return getHandler() === handler && Reflect.get(handler, 'check') === original;
		},
	};
}

/** @internal */
export function installDuplicateFilterObserver(
	client: object,
	onFiltered: (packet: DuplicateFilterPacket) => void,
): DuplicateFilterObserver {
	const observers: InstalledCheckObserver[] = [];
	try {
		observers.push(
			installCheckObserver(
				() => duplicateFilterHandler(client, 'memberUpdateHandler'),
				'GUILD_MEMBER_UPDATE',
				onFiltered,
			),
		);
		observers.push(
			installCheckObserver(
				() => duplicateFilterHandler(client, 'presenceUpdateHandler'),
				'PRESENCE_UPDATE',
				onFiltered,
			),
		);
	} catch (error) {
		for (const observer of observers.reverse()) observer.restore();
		throw error;
	}

	return {
		owned: () => observers.every(observer => observer.owned()),
		restore() {
			let restored = true;
			for (const observer of observers) restored = observer.restore() && restored;
			return restored;
		},
	};
}
