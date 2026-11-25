/**
 * Desired IDs a startup guild snapshot is authoritative for.
 *
 * A resource is listed only when its field was present in the payload: an absent field preserves what is
 * cached, a present empty array replaces it with nothing. Members, presences, bans, and messages never appear
 * because the startup snapshot is not a complete list of them.
 */
export interface GuildSnapshotPlan {
	readonly guildId: string;
	readonly roles?: ReadonlySet<string>;
	readonly emojis?: ReadonlySet<string>;
	readonly stickers?: ReadonlySet<string>;
	/** Non-thread channels. */
	readonly channels?: ReadonlySet<string>;
	/** Active threads the bot can view. Archived threads are not listed by Discord. */
	readonly threads?: ReadonlySet<string>;
	/**
	 * Channels whose cached overwrites must stay: the array is not empty, or the channel did not carry the field.
	 * Seyfert stores no entry for an empty array, so a channel listed with `[]` loses its previous one.
	 */
	readonly overwrites?: ReadonlySet<string>;
	/** Voice states, keyed by user. */
	readonly voiceStates?: ReadonlySet<string>;
	/** Stage instances, keyed by channel. */
	readonly stageInstances?: ReadonlySet<string>;
}

const THREAD_TYPES = new Set([10, 11, 12]);

export function planGuildSnapshot(guildId: string, payload: object): GuildSnapshotPlan {
	const channels = list(payload, 'channels');
	return {
		guildId,
		roles: ids(list(payload, 'roles'), 'id'),
		emojis: ids(list(payload, 'emojis'), 'id'),
		stickers: ids(list(payload, 'stickers'), 'id'),
		channels: ids(channels, 'id'),
		threads: ids(list(payload, 'threads'), 'id'),
		overwrites: ids(
			channels?.filter(channel => {
				const overwrites = Reflect.get(channel, 'permission_overwrites');
				return !Array.isArray(overwrites) || overwrites.length > 0;
			}),
			'id',
		),
		voiceStates: ids(list(payload, 'voice_states'), 'user_id'),
		stageInstances: ids(list(payload, 'stage_instances'), 'channel_id'),
	};
}

/**
 * Whether a cached entry of the shared channel namespace is stale under the snapshot.
 *
 * A non-thread channel is stale once it is missing from the channel list. A thread is stale only when it was
 * cached as active and is no longer listed; archived and unclassified entries are preserved because the
 * snapshot never lists them.
 */
export function isStaleChannel(plan: GuildSnapshotPlan, id: string, cached: unknown): boolean {
	if (plan.channels?.has(id) || plan.threads?.has(id)) return false;
	if (typeof cached !== 'object' || cached === null) return false;
	const type = Reflect.get(cached, 'type');
	if (typeof type !== 'number') return false;
	if (!THREAD_TYPES.has(type)) return plan.channels !== undefined;
	if (!plan.threads) return false;
	const metadata = Reflect.get(cached, 'thread_metadata');
	return typeof metadata === 'object' && metadata !== null && Reflect.get(metadata, 'archived') === false;
}

function list(payload: object, field: string): object[] | undefined {
	const value = Reflect.get(payload, field);
	if (!Array.isArray(value)) return;
	return value.filter(item => typeof item === 'object' && item !== null);
}

function ids(items: object[] | undefined, field: string): ReadonlySet<string> | undefined {
	if (!items) return;
	const result = new Set<string>();
	for (const item of items) {
		const id = Reflect.get(item, field);
		if (typeof id === 'string') result.add(id);
	}
	return result;
}
