import { type Cache, ChannelType } from 'seyfert';
import type { ReconciledAdapter } from './adapter';
import type { AdapterReconciliationController } from './adapter-controller';
import {
	type GatewayMutationContext,
	ReconciliationState,
	type SnapshotCompleteness,
	type SnapshotCut,
} from './reconciliation-state';

type SnapshotResource =
	| 'channels'
	| 'emojis'
	| 'guild'
	| 'overwrites'
	| 'roles'
	| 'stageInstances'
	| 'stickers'
	| 'voiceStates';

interface SnapshotRecord {
	readonly [key: PropertyKey]: unknown;
}

interface RelationshipResource {
	getToRelationship(scope: string): unknown;
}

export interface PreparedReconciliation {
	readonly cuts: ReadonlyMap<SnapshotResource, SnapshotCut>;
}

export interface SnapshotReconcilerOptions {
	readonly adapter: ReconciledAdapter;
	readonly cache: Cache;
	readonly calculateShardId: (guildId: string) => number | undefined;
	readonly controller: AdapterReconciliationController;
	readonly onFailure: (code: string, error: unknown) => void;
	readonly state: ReconciliationState;
}

function isRecord(value: unknown): value is SnapshotRecord {
	return typeof value === 'object' && value !== null;
}

function own(record: SnapshotRecord, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function stringField(record: SnapshotRecord, key: PropertyKey): string | undefined {
	const value = Reflect.get(record, key);
	return typeof value === 'string' ? value : undefined;
}

function arrayField(record: SnapshotRecord, key: PropertyKey): readonly unknown[] {
	const value = Reflect.get(record, key);
	if (!Array.isArray(value)) throw new TypeError(`Gateway snapshot field ${String(key)} must be an array.`);
	return value;
}

function objectArray(record: SnapshotRecord, key: PropertyKey): readonly SnapshotRecord[] {
	return arrayField(record, key).filter(isRecord);
}

function ids(values: readonly SnapshotRecord[], key: PropertyKey = 'id'): string[] {
	return values.flatMap(value => {
		const id = stringField(value, key);
		return id ? [id] : [];
	});
}

function isThreadType(type: unknown): boolean {
	return (
		type === ChannelType.AnnouncementThread || type === ChannelType.PublicThread || type === ChannelType.PrivateThread
	);
}

function physicalKey(namespace: string, id: string): string {
	return id.startsWith(`${namespace}.`) ? id : `${namespace}.${id}`;
}

/** Performs only diffs backed by complete Discord snapshots. @internal */
export class SnapshotReconciler {
	constructor(private readonly options: SnapshotReconcilerOptions) {}

	prepare(context: GatewayMutationContext, data: unknown): PreparedReconciliation {
		const cuts = new Map<SnapshotResource, SnapshotCut>();
		if (!isRecord(data)) return { cuts };
		const guildId = context.guildId;
		if (!guildId) return { cuts };

		const add = (
			resource: SnapshotResource,
			completeness: SnapshotCompleteness = 'authoritative',
			supersessionTarget?: string,
		) => {
			cuts.set(
				resource,
				this.options.state.recordSnapshot(context.position, {
					completeness,
					guildId,
					resource,
					supersessionTarget,
				}),
			);
		};

		switch (context.event) {
			case 'GUILD_CREATE':
			case 'RAW_GUILD_CREATE':
				if (Reflect.get(data, 'unavailable') === true) break;
				add('roles');
				add('channels');
				add('emojis');
				add('overwrites');
				add('voiceStates');
				add('stageInstances');
				add('stickers', own(data, 'stickers') ? 'authoritative' : 'partial');
				break;
			case 'GUILD_EMOJIS_UPDATE':
				add('emojis');
				break;
			case 'GUILD_STICKERS_UPDATE':
				add('stickers');
				break;
			case 'CHANNEL_CREATE':
			case 'CHANNEL_UPDATE':
			case 'THREAD_CREATE':
			case 'THREAD_UPDATE':
				if (own(data, 'permission_overwrites')) add('overwrites', 'authoritative', stringField(data, 'id'));
				break;
			case 'CHANNEL_DELETE':
			case 'THREAD_DELETE':
				add('channels', 'authoritative', stringField(data, 'id'));
				break;
		}
		return { cuts };
	}

	async reconcilePostCache(
		context: GatewayMutationContext,
		data: unknown,
		prepared: PreparedReconciliation,
	): Promise<void> {
		if (!isRecord(data)) return;
		switch (context.event) {
			case 'GUILD_CREATE':
			case 'RAW_GUILD_CREATE':
				await this.reconcileGuildSnapshot(context, data, prepared);
				break;
			case 'GUILD_EMOJIS_UPDATE':
				await this.reconcileListUpdate(
					'emoji',
					context.guildId,
					objectArray(data, 'emojis'),
					prepared.cuts.get('emojis'),
				);
				break;
			case 'GUILD_STICKERS_UPDATE':
				await this.reconcileListUpdate(
					'sticker',
					context.guildId,
					objectArray(data, 'stickers'),
					prepared.cuts.get('stickers'),
				);
				break;
			case 'CHANNEL_CREATE':
			case 'CHANNEL_UPDATE':
			case 'THREAD_CREATE':
			case 'THREAD_UPDATE':
				await this.reconcileOverwriteUpdate(context.guildId, data, prepared.cuts.get('overwrites'));
				break;
			case 'CHANNEL_DELETE':
			case 'THREAD_DELETE': {
				const channelId = stringField(data, 'id');
				const cut = prepared.cuts.get('channels');
				if (context.guildId && channelId && cut) await this.reconcileDeletedChannel(context.guildId, channelId, cut);
				break;
			}
		}
	}

	async reconcileStaleGuilds(context: GatewayMutationContext, expectedGuildIds: ReadonlySet<string>): Promise<void> {
		const guilds = this.options.cache.guilds;
		if (!guilds) return;
		const cachedGuildIds = await this.unfiltered(() => guilds.getToRelationship());
		let firstFailure: unknown;
		for (const guildId of cachedGuildIds) {
			if (expectedGuildIds.has(guildId) || this.options.calculateShardId(guildId) !== context.shardId) continue;
			const claim = this.options.controller.claimValueDelete(
				physicalKey('guild', guildId),
				this.options.state.recordSnapshot(context.position, {
					completeness: 'authoritative',
					guildId,
					resource: 'guild',
				}),
			);
			if (!claim) continue;
			const cascadeContext: GatewayMutationContext = {
				...context,
				deleteClaim: claim,
				guildId,
				mode: 'stale-guild-cascade',
			};
			try {
				await this.options.controller.runWithContext(cascadeContext, () =>
					this.options.adapter.runUnfiltered(() => guilds.remove(guildId)),
				);
			} catch (error) {
				firstFailure ??= error;
				this.options.onFailure('stale-guild-delete-failed', error);
			} finally {
				this.options.controller.releaseDeleteClaim(claim);
			}
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async reconcileGuildSnapshot(
		context: GatewayMutationContext,
		data: SnapshotRecord,
		prepared: PreparedReconciliation,
	): Promise<void> {
		if (!this.options.cache.guilds || Reflect.get(data, 'unavailable') === true) return;
		const guildId = context.guildId!;
		let firstFailure: unknown;
		const reconcile = async (operation: () => Promise<void>) => {
			try {
				await operation();
			} catch (error) {
				firstFailure ??= error;
			}
		};

		if (this.options.cache.roles) {
			await reconcile(() =>
				this.replaceRelationship('role', guildId, ids(objectArray(data, 'roles')), prepared.cuts.get('roles')!),
			);
		}
		if (this.options.cache.channels) {
			await reconcile(() => this.reconcileChannels(guildId, data, prepared.cuts.get('channels')!));
		}
		if (this.options.cache.emojis) {
			await reconcile(() =>
				this.replaceRelationship('emoji', guildId, ids(objectArray(data, 'emojis')), prepared.cuts.get('emojis')!),
			);
		}
		if (this.options.cache.stickers && own(data, 'stickers')) {
			await reconcile(() =>
				this.replaceRelationship(
					'sticker',
					guildId,
					ids(objectArray(data, 'stickers')),
					prepared.cuts.get('stickers')!,
				),
			);
		}
		if (this.options.cache.overwrites) {
			await reconcile(() => this.reconcileOverwrites(guildId, data, prepared.cuts.get('overwrites')!));
		}
		if (this.options.cache.voiceStates) {
			await reconcile(() =>
				this.replaceRelationship(
					'voice_state',
					guildId,
					ids(objectArray(data, 'voice_states'), 'user_id'),
					prepared.cuts.get('voiceStates')!,
					id => `voice_state.${guildId}.${id}`,
				),
			);
		}
		if (this.options.cache.stageInstances) {
			await reconcile(() =>
				this.replaceRelationship(
					'stage_instance',
					guildId,
					ids(objectArray(data, 'stage_instances')),
					prepared.cuts.get('stageInstances')!,
				),
			);
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async reconcileChannels(guildId: string, data: SnapshotRecord, cut: SnapshotCut): Promise<void> {
		const channels = objectArray(data, 'channels');
		const threads = objectArray(data, 'threads');
		const desired = new Set(ids([...channels, ...threads]));
		const cached = await this.relationshipIds(this.options.cache.channels!, guildId);
		const removable: string[] = [];
		for (const id of cached) {
			if (desired.has(id)) continue;
			const channel = await this.unfiltered(() => this.options.cache.channels!.raw(id));
			if (!channel || !isThreadType(Reflect.get(channel, 'type'))) {
				removable.push(id);
				continue;
			}
			const metadata = Reflect.get(channel, 'thread_metadata');
			if (isRecord(metadata) && Reflect.get(metadata, 'archived') === false) removable.push(id);
		}
		let firstFailure: unknown;
		for (const channelId of removable) {
			try {
				await this.reconcileChannelCandidate(guildId, channelId, cut);
			} catch (error) {
				firstFailure ??= error;
			}
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async reconcileChannelCandidate(guildId: string, channelId: string, cut: SnapshotCut): Promise<void> {
		const key = physicalKey('channel', channelId);
		const claim = this.options.controller.claimValueDelete(key, cut, channelId);
		if (!claim) return;
		let firstFailure: unknown;
		try {
			await this.reconcileDeletedChannel(guildId, channelId, cut);
		} catch (error) {
			firstFailure = error;
		}
		try {
			await this.options.adapter.reconcileDelete(key, claim, {
				id: channelId,
				to: physicalKey('channel', guildId),
			});
		} catch (error) {
			firstFailure ??= error;
			this.options.onFailure('snapshot-delete-failed', error);
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async reconcileDeletedChannel(guildId: string, channelId: string, cut: SnapshotCut): Promise<void> {
		let firstFailure: unknown;
		if (this.options.cache.messages) {
			try {
				const messageIds = await this.relationshipIds(this.options.cache.messages, channelId);
				await this.deleteCandidates('message', channelId, messageIds, cut, undefined, () => channelId);
			} catch (error) {
				firstFailure ??= error;
			}
		}
		if (this.options.cache.overwrites) {
			try {
				const overwriteIds = await this.relationshipIds(this.options.cache.overwrites, guildId);
				if (overwriteIds.includes(channelId)) {
					await this.deleteCandidates('overwrite', guildId, [channelId], cut, undefined, () => channelId);
				}
			} catch (error) {
				firstFailure ??= error;
			}
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async reconcileOverwrites(guildId: string, data: SnapshotRecord, cut: SnapshotCut): Promise<void> {
		const channelRecords = [...objectArray(data, 'channels'), ...objectArray(data, 'threads')];
		const snapshotIds = new Set(ids(channelRecords));
		const desired = new Set<string>();
		const preserved = new Set<string>();
		for (const channel of channelRecords) {
			const id = stringField(channel, 'id');
			if (!id) continue;
			if (!own(channel, 'permission_overwrites')) {
				preserved.add(id);
				continue;
			}
			if (arrayField(channel, 'permission_overwrites').length > 0) desired.add(id);
		}
		const cached = await this.relationshipIds(this.options.cache.overwrites!, guildId);
		const removable = cached.filter(id => !desired.has(id) && (!snapshotIds.has(id) || !preserved.has(id)));
		await this.deleteCandidates('overwrite', guildId, removable, cut);
	}

	private async reconcileListUpdate(
		namespace: 'emoji' | 'sticker',
		guildId: string | undefined,
		values: readonly SnapshotRecord[],
		cut: SnapshotCut | undefined,
	): Promise<void> {
		if (!guildId || !cut) return;
		const resource = namespace === 'emoji' ? this.options.cache.emojis : this.options.cache.stickers;
		if (!resource) return;
		await this.replaceRelationship(namespace, guildId, ids(values), cut);
	}

	private async reconcileOverwriteUpdate(
		guildId: string | undefined,
		data: SnapshotRecord,
		cut: SnapshotCut | undefined,
	): Promise<void> {
		if (!guildId || !cut || !this.options.cache.overwrites || !own(data, 'permission_overwrites')) return;
		if (arrayField(data, 'permission_overwrites').length > 0) return;
		const channelId = stringField(data, 'id');
		if (!channelId) return;
		const cached = await this.relationshipIds(this.options.cache.overwrites, guildId);
		if (cached.includes(channelId)) await this.deleteCandidates('overwrite', guildId, [channelId], cut);
	}

	private async replaceRelationship(
		namespace: string,
		scope: string,
		desiredIds: readonly string[],
		cut: SnapshotCut,
		keyFor: (id: string) => string = id => physicalKey(namespace, id),
	): Promise<void> {
		const resource = this.resource(namespace);
		const cached = await this.relationshipIds(resource, scope);
		const desired = new Set(desiredIds);
		await this.deleteCandidates(
			namespace,
			scope,
			cached.filter(id => !desired.has(id)),
			cut,
			keyFor,
		);
	}

	private async deleteCandidates(
		namespace: string,
		scope: string,
		candidateIds: readonly string[],
		cut: SnapshotCut,
		keyFor: (id: string) => string = id => physicalKey(namespace, id),
		supersessionTargetFor: (id: string) => string = id => id,
	): Promise<void> {
		let firstFailure: unknown;
		const relationship = physicalKey(namespace, scope);
		for (const id of candidateIds) {
			const key = keyFor(id);
			const claim = this.options.controller.claimValueDelete(key, cut, supersessionTargetFor(id));
			if (!claim) continue;
			try {
				await this.options.adapter.reconcileDelete(key, claim, { id, to: relationship });
			} catch (error) {
				firstFailure ??= error;
				this.options.onFailure('snapshot-delete-failed', error);
			}
		}
		if (firstFailure !== undefined) throw firstFailure;
	}

	private async relationshipIds(resource: RelationshipResource, scope: string): Promise<string[]> {
		return (await this.unfiltered(() => resource.getToRelationship(scope))) as string[];
	}

	private resource(namespace: string): RelationshipResource {
		switch (namespace) {
			case 'channel':
				return this.options.cache.channels!;
			case 'emoji':
				return this.options.cache.emojis!;
			case 'overwrite':
				return this.options.cache.overwrites!;
			case 'role':
				return this.options.cache.roles!;
			case 'stage_instance':
				return this.options.cache.stageInstances!;
			case 'sticker':
				return this.options.cache.stickers!;
			case 'voice_state':
				return this.options.cache.voiceStates!;
			default:
				throw new Error(`Unsupported snapshot namespace ${namespace}.`);
		}
	}

	private unfiltered<T>(operation: () => T): T {
		return this.options.adapter.runUnfiltered(operation);
	}
}
