import type { KeyTarget } from './state';

/**
 * How Seyfert files each core resource, following the adapter contract: keys are `resource.id` or
 * `resource.scope.id`, and a relationship is `resource` or `resource.scope`.
 *
 * `replaceable` is the resource policy: only these resources are listed completely by a startup guild snapshot,
 * so only they may be deleted for being absent from it.
 */
const RESOURCES: ReadonlyMap<string, { scoped: boolean; replaceable: boolean }> = new Map([
	['guild', { scoped: false, replaceable: false }],
	['user', { scoped: false, replaceable: false }],
	['role', { scoped: true, replaceable: true }],
	['channel', { scoped: true, replaceable: true }],
	['emoji', { scoped: true, replaceable: true }],
	['sticker', { scoped: true, replaceable: true }],
	['overwrite', { scoped: true, replaceable: true }],
	['stage_instance', { scoped: true, replaceable: true }],
	['voice_state', { scoped: true, replaceable: true }],
	['member', { scoped: true, replaceable: false }],
	['presence', { scoped: true, replaceable: false }],
	['ban', { scoped: true, replaceable: false }],
	// Messages are scoped by channel; their guild is the one their channel was filed under, when that is known.
	['message', { scoped: false, replaceable: false }],
]);

const GUILD = 'guild';
const MESSAGE = 'message';
const CHANNEL = 'channel';

/**
 * Classifies adapter keys and relationships.
 *
 * Only Seyfert's core resources are reconciled. Anything else on the same adapter, such as another plugin's
 * resource, is unmanaged and passes through untouched.
 *
 * @internal
 */
export class KeyLayout {
	/** `applicationId` resolves lazily because the client only learns it from READY. */
	constructor(private readonly applicationId: () => string | undefined) {}

	/** Whether a key, relationship, or scan query addresses a reconciled resource. */
	manages(name: string): boolean {
		return RESOURCES.has(namespaceOf(name));
	}

	/** The guild a guild-record key stands for. */
	guildRecord(key: string): string | undefined {
		return namespaceOf(key) === GUILD ? key.slice(GUILD.length + 1) : undefined;
	}

	/** Everything the visibility state needs to know about a write, or `undefined` for an unmanaged key. */
	target(key: string, relationship: readonly [to: string, id: string]): KeyTarget | undefined {
		const [to, id] = relationship;
		const namespace = namespaceOf(to);
		const resource = RESOURCES.get(namespace);
		if (!resource) return;
		return {
			key,
			to,
			id,
			guildId: namespace === GUILD ? guildScope(id) : resource.scoped ? this.guildOf(to) : undefined,
			replaceable: resource.replaceable,
		};
	}

	/**
	 * The channel key a message relationship hangs from. A message belongs to its channel's guild, which the key
	 * alone does not name, so the coordinator resolves it from the channel it filed.
	 */
	messageChannel(to: string): string | undefined {
		return namespaceOf(to) === MESSAGE && to.length > MESSAGE.length
			? `${CHANNEL}${to.slice(MESSAGE.length)}`
			: undefined;
	}

	/**
	 * The guild partition a scoped relationship belongs to. The scope is not a guild for DM channels (`@me`) or
	 * for application emojis, which Seyfert files under the application ID.
	 */
	private guildOf(to: string): string | undefined {
		const separator = to.indexOf('.');
		if (separator === -1) return;
		const scope = guildScope(to.slice(separator + 1));
		return scope === this.applicationId() ? undefined : scope;
	}
}

function namespaceOf(name: string): string {
	const separator = name.indexOf('.');
	return separator === -1 ? name : name.slice(0, separator);
}

function guildScope(scope: string): string | undefined {
	return /^\d+$/.test(scope) ? scope : undefined;
}
