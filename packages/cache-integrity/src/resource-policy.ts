import type { AdapterMutationAdmission, AdapterMutationTarget } from './adapter-controller';
import {
	type GatewayMutationContext,
	GLOBAL_VISIBILITY_SCOPE,
	ReconciliationState,
	type ShardGeneration,
	type VisibilityScope,
} from './reconciliation-state';

const GUILD_BASED_NAMESPACES = new Set(['ban', 'member', 'voice_state']);
const GUILD_RELATED_NAMESPACES = new Set([
	'channel',
	'emoji',
	'message',
	'overwrite',
	'presence',
	'role',
	'stage_instance',
	'sticker',
]);
const MANAGED_NAMESPACES = new Set(['guild', 'user', ...GUILD_BASED_NAMESPACES, ...GUILD_RELATED_NAMESPACES]);

function namespaceOf(key: string): string {
	const separator = key.indexOf('.');
	return separator === -1 ? key : key.slice(0, separator);
}

function segmentsAfterNamespace(key: string): string[] {
	const separator = key.indexOf('.');
	return separator === -1 ? [] : key.slice(separator + 1).split('.');
}

function guildIdFromData(data: unknown): string | undefined {
	if (Array.isArray(data)) {
		for (const value of data) {
			const guildId = guildIdFromData(value);
			if (guildId) return guildId;
		}
		return;
	}
	if (!data || typeof data !== 'object') return;
	const guildId = Reflect.get(data, 'guild_id');
	return typeof guildId === 'string' ? guildId : undefined;
}

function tracked(scope: VisibilityScope): AdapterMutationAdmission {
	return { kind: 'tracked', scope };
}

/** Assigns each public Seyfert cache mutation to its physical ownership scope. @internal */
export class ResourcePolicy {
	constructor(
		private readonly state: ReconciliationState,
		private readonly calculateShardId: (guildId: string) => number | undefined,
		private readonly physicalKeyPrefix?: string,
	) {}

	canonicalizeKey(key: string): string {
		if (!this.physicalKeyPrefix || !key.startsWith(this.physicalKeyPrefix)) return key;
		const logicalKey = key.slice(this.physicalKeyPrefix.length);
		return MANAGED_NAMESPACES.has(namespaceOf(logicalKey)) ? logicalKey : key;
	}

	isManagedValue(key: string): boolean {
		return MANAGED_NAMESPACES.has(namespaceOf(key));
	}

	isManagedRelationship(to: string): boolean {
		return MANAGED_NAMESPACES.has(namespaceOf(to));
	}

	resolveAdmission(
		target: AdapterMutationTarget,
		context: GatewayMutationContext | undefined,
	): AdapterMutationAdmission {
		const namespace = namespaceOf(target.kind === 'value' ? target.key : target.to);
		if (!MANAGED_NAMESPACES.has(namespace)) return { kind: 'unmanaged' };
		if (this.state.lifecycle !== 'active') return { kind: 'denied' };
		if (context && !this.state.isCurrentGeneration(context.position.generation)) return { kind: 'denied' };
		if (context?.mode === 'stale-guild-cascade') {
			if (!context.deleteClaim || !this.state.isDeleteClaimCurrent(context.deleteClaim)) {
				return { kind: 'denied' };
			}
			if (target.kind === 'value' && namespace === 'presence') return { kind: 'denied' };
		}

		const scope =
			target.kind === 'value'
				? this.valueScope(namespace, target, context)
				: this.relationshipScope(namespace, target, context);
		return scope ? tracked(scope) : { kind: 'unmanaged' };
	}

	private valueScope(
		namespace: string,
		target: Extract<AdapterMutationTarget, { kind: 'value' }>,
		context: GatewayMutationContext | undefined,
	): VisibilityScope | undefined {
		if (namespace === 'user' || namespace === 'presence') return GLOBAL_VISIBILITY_SCOPE;
		if (namespace === 'guild') return this.guildScope(segmentsAfterNamespace(target.key)[0], context);
		if (GUILD_BASED_NAMESPACES.has(namespace)) {
			return this.guildScope(segmentsAfterNamespace(target.key)[0], context);
		}

		const guildId = guildIdFromData(target.data) ?? context?.guildId;
		if (guildId === '@me') return GLOBAL_VISIBILITY_SCOPE;
		if (guildId) return this.guildScope(guildId, context);
		if (context && (namespace === 'message' || namespace === 'channel')) return GLOBAL_VISIBILITY_SCOPE;
		return context?.position.generation;
	}

	private relationshipScope(
		namespace: string,
		target: Extract<AdapterMutationTarget, { kind: 'relationship' }>,
		context: GatewayMutationContext | undefined,
	): VisibilityScope | undefined {
		if (namespace === 'user') return GLOBAL_VISIBILITY_SCOPE;
		if (namespace === 'guild') return this.guildScope(target.id, context);
		const ownerId = segmentsAfterNamespace(target.to)[0];
		if (ownerId === '@me') return GLOBAL_VISIBILITY_SCOPE;
		if (namespace === 'message') {
			if (!context) return;
			return context.guildId ? context.position.generation : GLOBAL_VISIBILITY_SCOPE;
		}
		return this.guildScope(ownerId ?? context?.guildId, context);
	}

	private guildScope(
		guildId: string | undefined,
		context: GatewayMutationContext | undefined,
	): ShardGeneration | undefined {
		if (guildId && context?.guildId && guildId !== context.guildId) return;
		if (context) return context.position.generation;
		if (!guildId) return;
		const shardId = this.calculateShardId(guildId);
		return shardId === undefined ? undefined : this.state.activeGeneration(shardId);
	}
}
