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

/** Opt-in span naming for handlers that own a stable operation name. */
export interface TelemetryMetadata<Context = unknown> {
	spanName?: string | ((context: Context) => string | undefined);
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
	if (customId) attrs['seyfert.custom_id'] = customId;

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

function declaredName(handler: unknown, context: unknown): string | undefined {
	const spanName = asRecord(handler).spanName;
	if (typeof spanName === 'string') return getString(spanName);
	if (typeof spanName !== 'function') return undefined;
	try {
		return getString((spanName as (context: unknown) => unknown)(context));
	} catch {
		return undefined;
	}
}

/**
 * Handler identity, never the runtime `customId`: a handler declaring a RegExp or a
 * `filter` matches unboundedly many ids, and span names must stay low-cardinality.
 */
function handlerName(handler: unknown, context: unknown): string | undefined {
	if (handler === null || typeof handler !== 'object') return undefined;

	const declared = declaredName(handler, context);
	if (declared) return declared;

	const source = asRecord(handler);
	const customId = getString(source.customId);
	if (customId) return customId;

	const className = getString((source.constructor as { name?: unknown } | undefined)?.name);
	return className === 'Object' ? undefined : className;
}

export function interactionSpanName(kind: InteractionKind, context: unknown): string {
	const source = asRecord(context);
	if (kind === 'command') {
		const command = getString(source.fullCommandName ?? source.commandName) ?? 'unknown';
		return `command ${command}`;
	}

	return `${kind} ${handlerName(source.command, context) ?? 'unknown'}`;
}
