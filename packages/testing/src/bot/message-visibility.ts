import { PermissionFlagsBits } from 'seyfert';
import { isEphemeral } from './message-flags';
import type { ApiChannel } from './payloads';
import { computeChannelPermissions } from './permissions';
import type { WorldState } from './state';
import type { WorldData, WorldMessageEntry } from './world';

/**
 * Whether a user can open a channel. `permissions` is set in guild channels and absent in DMs, where no
 * history permission applies.
 */
export type ChannelAccess =
	| { visible: false; denial: 'unknown-channel' | 'no-view-channel' | 'dm-recipient-unverified' }
	| { visible: true; permissions?: bigint };

/** Why a message in a channel the user can open is still hidden from them. */
export type MessageDenial = 'ephemeral-owner-unknown' | 'ephemeral-not-owner' | 'history-hidden';

function memberChannelPermissions(world: WorldData, channel: ApiChannel, userId: string): bigint | undefined {
	const guild = world.guilds.find(candidate => candidate.id === channel.guild_id);
	const member = world.members.find(
		candidate => candidate.guildId === channel.guild_id && candidate.member.user.id === userId,
	);
	if (!guild || !member) return undefined;
	const roles = world.roles.filter(candidate => candidate.guildId === guild.id).map(candidate => candidate.role);
	return BigInt(computeChannelPermissions({ guild, roles, member: { userId, roles: member.member.roles }, channel }));
}

function canView(permissions: bigint | undefined): permissions is bigint {
	return permissions !== undefined && (permissions & PermissionFlagsBits.ViewChannel) !== 0n;
}

/**
 * Users who receive a message live as it is created: guild members who joined before it and can view its
 * channel. An ephemeral message reaches only its owner. DM messages record no recipients.
 */
export function liveRecipients(world: WorldData, entry: WorldMessageEntry): string[] {
	const channel = world.channels.find(candidate => candidate.id === entry.channelId);
	if (!channel?.guild_id) return [];
	const ephemeral = isEphemeral(entry.message);
	return world.members
		.filter(({ guildId }) => guildId === channel.guild_id)
		.map(({ member }) => member.user.id)
		.filter(
			userId =>
				(world.joinSequence?.[userId] ?? entry.sequence) < entry.sequence &&
				(!ephemeral || userId === entry.ownerId) &&
				canView(memberChannelPermissions(world, channel, userId)),
		);
}

export function channelAccess(
	world: WorldData | undefined,
	state: WorldState,
	channelId: string,
	userId: string,
): ChannelAccess {
	const channel = world?.channels.find(candidate => candidate.id === channelId);
	if (!world || !channel) return { visible: false, denial: 'unknown-channel' };
	if (!channel.guild_id) {
		return state.verifiedDmRecipient(userId, channelId)
			? { visible: true }
			: { visible: false, denial: 'dm-recipient-unverified' };
	}
	const permissions = memberChannelPermissions(world, channel, userId);
	return canView(permissions) ? { visible: true, permissions } : { visible: false, denial: 'no-view-channel' };
}

/**
 * Why `userId` cannot see `entry` in a channel they can open, or undefined when they can. An ephemeral message
 * is visible only to a known owner; without ReadMessageHistory a user sees only what reached them live.
 */
export function messageDenial(
	entry: WorldMessageEntry,
	userId: string,
	permissions: bigint | undefined,
): MessageDenial | undefined {
	if (isEphemeral(entry.message)) {
		if (entry.ownerId === undefined) return 'ephemeral-owner-unknown';
		return entry.ownerId === userId ? undefined : 'ephemeral-not-owner';
	}
	const readsHistory = permissions === undefined || (permissions & PermissionFlagsBits.ReadMessageHistory) !== 0n;
	if (!readsHistory && !entry.liveRecipientIds?.includes(userId)) return 'history-hidden';
	return undefined;
}
