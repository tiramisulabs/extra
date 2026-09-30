import { PermissionFlagsBits } from 'seyfert';
import { isEphemeral } from './message-flags';
import { computeChannelPermissions } from './permissions';
import type { WorldState } from './state';
import type { WorldData } from './world';

type MessageEntry = WorldData['messages'][number];

export function liveRecipients(
	world: WorldData,
	channelId: string,
	sequence: number,
	ownerId?: string,
	ephemeral = false,
): string[] {
	const channel = world.channels.find(candidate => candidate.id === channelId);
	if (!channel?.guild_id) return [];
	const guild = world.guilds.find(candidate => candidate.id === channel.guild_id);
	if (!guild) return [];
	const roles = world.roles.filter(candidate => candidate.guildId === guild.id).map(candidate => candidate.role);
	return world.members
		.filter(candidate => candidate.guildId === guild.id)
		.filter(({ member }) => (world.connections?.[member.user.id] ?? sequence) < sequence)
		.filter(({ member }) => !ephemeral || member.user.id === ownerId)
		.filter(({ member }) =>
			Boolean(
				BigInt(
					computeChannelPermissions({ guild, roles, member: { userId: member.user.id, roles: member.roles }, channel }),
				) & PermissionFlagsBits.ViewChannel,
			),
		)
		.map(({ member }) => member.user.id);
}

export function messageAccess(
	world: WorldData | undefined,
	state: WorldState,
	channelId: string,
	userId?: string,
	entry?: MessageEntry,
): { visible: boolean; diagnostics: string[] } {
	const channel = world?.channels.find(candidate => candidate.id === channelId);
	if (!channel) return { visible: false, diagnostics: ['unknown-channel'] };
	const diagnostics: string[] = [];
	let permissions: bigint | undefined;
	if (userId && channel.guild_id) {
		const guild = world?.guilds.find(candidate => candidate.id === channel.guild_id);
		const member = world?.members.find(
			candidate => candidate.guildId === channel.guild_id && candidate.member.user.id === userId,
		);
		if (!guild || !member) return { visible: false, diagnostics: ['no-view-channel'] };
		permissions = BigInt(
			computeChannelPermissions({
				guild,
				roles: world?.roles.filter(candidate => candidate.guildId === guild.id).map(candidate => candidate.role) ?? [],
				member: { userId, roles: member.member.roles },
				channel,
			}),
		);
		if (!(permissions & PermissionFlagsBits.ViewChannel)) {
			return { visible: false, diagnostics: ['no-view-channel'] };
		}
	} else if (userId && !state.verifiedDmRecipient(userId, channelId)) {
		return { visible: false, diagnostics: ['dm-recipient-unverified'] };
	}
	if (entry && isEphemeral(entry.message)) {
		if (entry.ownerId === undefined) {
			diagnostics.push('ephemeral-owner-unknown');
			if (userId) return { visible: false, diagnostics };
		} else if (userId && entry.ownerId !== userId) {
			return { visible: false, diagnostics: [...diagnostics, 'ephemeral-not-owner'] };
		}
	}
	if (
		entry &&
		userId &&
		permissions !== undefined &&
		!(permissions & PermissionFlagsBits.ReadMessageHistory) &&
		!entry.liveRecipientIds?.includes(userId) &&
		!(isEphemeral(entry.message) && entry.ownerId === userId)
	)
		return { visible: false, diagnostics: ['history-hidden'] };
	return { visible: true, diagnostics };
}
