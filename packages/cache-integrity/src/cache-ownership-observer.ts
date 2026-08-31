import type { Cache } from 'seyfert';
import type { AdapterReconciliationController } from './adapter-controller';
import { GLOBAL_VISIBILITY_SCOPE, type ReconciliationState, type VisibilityScope } from './reconciliation-state';

interface InstalledMethodObserver {
	owned(): boolean;
	restore(): boolean;
}

/** @internal */
export interface CacheOwnershipObserver {
	owned(): boolean;
	restore(): boolean;
}

type HintBuilder = (args: readonly unknown[]) => ReadonlyMap<string, VisibilityScope>;

function record(value: unknown): object | undefined {
	return value !== null && typeof value === 'object' ? value : undefined;
}

function installMethodObserver(
	getTarget: () => object | undefined,
	method: string,
	controller: AdapterReconciliationController,
	buildHints: HintBuilder,
): InstalledMethodObserver | undefined {
	const target = getTarget();
	if (!target) return;
	const originalDescriptor = Object.getOwnPropertyDescriptor(target, method);
	const original = Reflect.get(target, method);
	if (typeof original !== 'function') throw new TypeError(`Seyfert cache owner does not expose ${method}().`);
	const wrapped = function (this: object, ...args: unknown[]) {
		const hints = buildHints(args);
		return controller.runWithOwnershipHints(hints, () => Reflect.apply(original, this, args));
	};
	Object.defineProperty(target, method, {
		configurable: true,
		value: wrapped,
		writable: true,
	});

	const owned = () => getTarget() === target && Reflect.get(target, method) === wrapped;
	return {
		owned,
		restore() {
			if (!owned()) return false;
			try {
				if (originalDescriptor) Object.defineProperty(target, method, originalDescriptor);
				else if (!Reflect.deleteProperty(target, method)) return false;
			} catch {
				return false;
			}
			return getTarget() === target && Reflect.get(target, method) === original;
		},
	};
}

/** @internal */
export function installCacheOwnershipObserver(
	cache: Cache,
	controller: AdapterReconciliationController,
	state: ReconciliationState,
	calculateShardId: (guildId: string) => number | undefined,
): CacheOwnershipObserver {
	const scopeForGuild = (guildId: string): VisibilityScope | undefined => {
		const shardId = calculateShardId(guildId);
		return shardId === undefined ? undefined : state.activeGeneration(shardId);
	};
	const messageHints: HintBuilder = args => {
		const hints = new Map<string, VisibilityScope>();
		if (!Array.isArray(args[0])) return hints;
		for (const entry of args[0]) {
			if (!Array.isArray(entry) || entry[1] !== 'messages') continue;
			const data = record(entry[2]);
			const id = entry[3];
			const channelId = entry[4];
			if (!data || typeof id !== 'string' || typeof channelId !== 'string') continue;
			const guildId = Reflect.get(data, 'guild_id');
			const scope = typeof guildId === 'string' && guildId !== '@me' ? scopeForGuild(guildId) : GLOBAL_VISIBILITY_SCOPE;
			if (!scope) continue;
			hints.set(controller.valueStateKey(`message.${id}`), scope);
			hints.set(controller.relationshipStateKey(`message.${channelId}`, id), scope);
		}
		return hints;
	};
	const overwriteHints: HintBuilder = args => {
		const hints = new Map<string, VisibilityScope>();
		const guildId = args[2];
		if (typeof guildId !== 'string') return hints;
		const scope = scopeForGuild(guildId);
		if (!scope) return hints;
		const input = args[1];
		const ids = Array.isArray(input)
			? input.flatMap(entry => (Array.isArray(entry) && typeof entry[0] === 'string' ? [entry[0]] : []))
			: typeof input === 'string'
				? [input]
				: [];
		for (const id of ids) {
			hints.set(controller.valueStateKey(`overwrite.${id}`), scope);
			hints.set(controller.relationshipStateKey(`overwrite.${guildId}`, id), scope);
		}
		return hints;
	};

	const observers: InstalledMethodObserver[] = [];
	const install = (observer: InstalledMethodObserver | undefined) => {
		if (observer) observers.push(observer);
	};
	try {
		install(installMethodObserver(() => cache, 'bulkSet', controller, messageHints));
		install(installMethodObserver(() => cache, 'bulkPatch', controller, messageHints));
		install(installMethodObserver(() => cache.overwrites, 'set', controller, overwriteHints));
		install(installMethodObserver(() => cache.overwrites, 'patch', controller, overwriteHints));
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
