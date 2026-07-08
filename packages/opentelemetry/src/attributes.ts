import type { Attributes } from '@opentelemetry/api';

export type InteractionKind = 'command' | 'component' | 'modal';

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const CUSTOM_ID_MAX = 64;

export function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function extractInteractionAttributes(kind: InteractionKind, context: unknown): Attributes {
	const source = asRecord(context);
	const interaction = asRecord(source.interaction ?? source);
	const member = asRecord(source.member ?? interaction.member);
	const author = asRecord(source.author ?? source.user ?? interaction.user ?? member.user);

	const attrs: Attributes = {
		'seyfert.interaction.kind': kind,
	};

	const command = getString(source.fullCommandName ?? source.commandName ?? asRecord(source.command).name);
	if (command) attrs['seyfert.command'] = command;

	const customId = getString(source.customId ?? interaction.customId);
	if (customId) attrs['seyfert.custom_id'] = truncate(customId, CUSTOM_ID_MAX);

	const guildId = getString(source.guildId ?? interaction.guildId);
	if (guildId) attrs['seyfert.guild_id'] = guildId;

	const channelId = getString(source.channelId ?? interaction.channelId);
	if (channelId) attrs['seyfert.channel_id'] = channelId;

	const userId = getString(author.id);
	if (userId) attrs['seyfert.user_id'] = userId;

	const interactionId = getString(source.interactionId ?? interaction.id ?? source.id);
	if (interactionId) attrs['seyfert.interaction_id'] = interactionId;

	const shardId = getNumber(source.shardId ?? interaction.shardId);
	if (shardId !== undefined) attrs['seyfert.shard_id'] = shardId;

	return attrs;
}

export function interactionSpanName(kind: InteractionKind, context: unknown): string {
	const source = asRecord(context);
	if (kind === 'command') {
		const command = getString(source.fullCommandName ?? source.commandName) ?? 'unknown';
		return `command ${command}`;
	}
	const customId = getString(source.customId ?? asRecord(source.interaction).customId) ?? 'unknown';
	return `${kind} ${truncate(customId, CUSTOM_ID_MAX)}`;
}
