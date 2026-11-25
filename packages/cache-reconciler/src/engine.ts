import type { Cache } from 'seyfert';
import { type ReconciledAdapter, runUnfiltered } from './adapter';
import { type CoordinatorBinding, ReconciliationCancelled } from './coordinator';
import type { KeyLayout } from './keys';
import { type GuildSnapshotPlan, isStaleChannel } from './snapshot';
import type { GuildClaim, GuildOutcome, GuildWork, KeyTarget, ReconciliationState } from './state';

/** @internal */
export interface EngineHost {
	readonly cache: Cache;
	readonly wrapper: ReconciledAdapter;
	readonly binding: CoordinatorBinding;
	readonly layout: KeyLayout;
	readonly state: ReconciliationState;
}

/**
 * Physical cleanup that follows authoritative evidence.
 *
 * Discovery always reads the wrapped adapter, never the filtered view, because what it looks for is exactly
 * what callers can no longer see. Every delete goes through a claim the state can still revoke.
 *
 * @internal
 */
export class ReconciliationEngine {
	constructor(private readonly host: EngineHost) {}

	/**
	 * Removes what a startup guild snapshot no longer lists. Members, presences, bans, and messages are never
	 * candidates: the snapshot is not a complete list of them, so absent entries just stay unreadable.
	 */
	async sweepSnapshot(work: GuildWork, plan: GuildSnapshotPlan): Promise<GuildOutcome> {
		const { cache } = this.host;
		const targets = (
			await Promise.all([
				this.absent(cache.roles, plan.guildId, plan.roles),
				this.absent(cache.emojis, plan.guildId, plan.emojis),
				this.absent(cache.stickers, plan.guildId, plan.stickers),
				this.absent(cache.overwrites, plan.guildId, plan.overwrites),
				this.absent(cache.voiceStates, plan.guildId, plan.voiceStates),
				this.absent(cache.stageInstances, plan.guildId, plan.stageInstances),
				this.staleChannels(plan),
			])
		).flat();
		if (!targets.length) return 'reconciled';
		const cut = { generation: work.generation, guildId: work.guildId, sequence: work.sequence };
		const result = await this.host.binding.sweep(targets, cut);
		return result.failed.length ? 'failed' : 'reconciled';
	}

	/**
	 * Removes what is left of a guild Discord reported as removed. Seyfert already removed what it could see;
	 * its own cascade runs again without the read filter so descendants hidden from callers go too. A guild
	 * the bot joined again after the delete is left alone.
	 */
	async removeGuild(work: GuildWork): Promise<GuildOutcome> {
		// Seyfert closes the partition by removing the guild record; a client that caches no guild records never does.
		await this.host.binding.closeGuild(work.guildId, work.sequence);
		const claim = this.host.state.claimGuild(work.generation, work.guildId, work);
		if (claim) await this.cascade(claim);
		return 'deleted';
	}

	/**
	 * Removes the guilds of a shard that its committed startup snapshot never listed: the bot left them while
	 * this cache was not being updated.
	 */
	async sweepStaleGuilds(generation: number): Promise<void> {
		const { cache, state, wrapper } = this.host;
		const known = state.knownGuilds(generation);
		if (!cache.guilds || !known) return;
		for (const guildId of await wrapper.inner.getToRelationship(cache.guilds.namespace)) {
			if (known.has(guildId)) continue;
			// Refused for a guild another shard owns, one that was observed meanwhile, or a superseded generation.
			const claim = state.claimGuild(generation, guildId);
			if (!claim) continue;
			try {
				await this.cascade(claim);
			} catch (cause) {
				state.recordFailure({
					kind: 'guild',
					message: 'A guild the shard is no longer in could not be removed; it stays hidden.',
					guildId,
					cause,
				});
			}
		}
	}

	/** Runs Seyfert's guild cascade over everything stored for the guild. A superseded claim just stops it. */
	private async cascade(claim: GuildClaim): Promise<void> {
		const guilds = this.host.cache.guilds;
		if (!guilds) return;
		try {
			await runUnfiltered(this.host.wrapper, claim, () => guilds.remove(claim.guildId));
		} catch (error) {
			if (!(error instanceof ReconciliationCancelled)) throw error;
		}
	}

	/** Stored members of a guild relationship that the snapshot lists the resource for but not the member. */
	private async absent(
		resource: { namespace: string } | undefined,
		guildId: string,
		desired: ReadonlySet<string> | undefined,
	): Promise<KeyTarget[]> {
		// A disabled resource is not cached; an absent field says nothing about what is cached.
		if (!resource || !desired) return [];
		const { layout, wrapper } = this.host;
		const targets: KeyTarget[] = [];
		for (const id of await wrapper.inner.getToRelationship(layout.guildRelationship(resource.namespace, guildId))) {
			const target = desired.has(id) ? undefined : layout.guildMember(resource.namespace, guildId, id);
			if (target) targets.push(target);
		}
		return targets;
	}

	/** Channels and threads share one namespace, so a stored entry is judged by its own type. */
	private async staleChannels(plan: GuildSnapshotPlan): Promise<KeyTarget[]> {
		const channels = this.host.cache.channels;
		if (!channels || (!plan.channels && !plan.threads)) return [];
		const { layout, wrapper } = this.host;
		const unlisted: KeyTarget[] = [];
		for (const id of await wrapper.inner.getToRelationship(
			layout.guildRelationship(channels.namespace, plan.guildId),
		)) {
			if (plan.channels?.has(id) || plan.threads?.has(id)) continue;
			const target = layout.guildMember(channels.namespace, plan.guildId, id);
			if (target) unlisted.push(target);
		}
		if (!unlisted.length) return [];
		// A bulk read does not keep positions for missing entries; each value names itself.
		const stale = new Set<string>();
		for (const value of await wrapper.inner.bulkGet(unlisted.map(target => target.key))) {
			const id: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : undefined;
			if (typeof id === 'string' && isStaleChannel(plan, id, value)) stale.add(id);
		}
		return unlisted.filter(target => stale.has(target.id));
	}
}
