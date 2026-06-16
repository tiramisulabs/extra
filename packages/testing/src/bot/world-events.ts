import { emojiKey } from './emoji';
import type { WorldState } from './state';

/**
 * Canonical set of gateway events the mock auto-applies to world state. Source of truth for both
 * directions: typing `WORLD_EVENT_MUTATORS` as `Record<WorldEmitEvent, …>` makes a union member with
 * no mutator (and a mutator with no union member) a compile error, and typing the REST→gateway `emit`
 * bridge to it makes emitting an unhandled/typo'd event name a compile error.
 */
export type WorldEmitEvent =
	| 'GUILD_MEMBER_ADD'
	| 'GUILD_MEMBER_REMOVE'
	| 'GUILD_MEMBER_UPDATE'
	| 'CHANNEL_CREATE'
	| 'CHANNEL_DELETE'
	| 'MESSAGE_CREATE'
	| 'MESSAGE_DELETE'
	| 'MESSAGE_REACTION_ADD'
	| 'MESSAGE_REACTION_REMOVE'
	| 'MESSAGE_REACTION_REMOVE_ALL'
	| 'MESSAGE_REACTION_REMOVE_EMOJI'
	| 'VOICE_STATE_UPDATE'
	| 'THREAD_CREATE'
	| 'THREAD_DELETE';

type WorldEventMutator = (state: WorldState, d: Record<string, unknown>) => void;

const WORLD_EVENT_MUTATORS: Record<WorldEmitEvent, WorldEventMutator> = {
	GUILD_MEMBER_ADD: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		if (guildId) state.addMember(guildId, d);
	},
	GUILD_MEMBER_REMOVE: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		const user = d.user as { id?: string } | undefined;
		if (guildId && user?.id) state.removeMember(guildId, user.id, false);
	},
	GUILD_MEMBER_UPDATE: (state, d) => {
		const guildId = typeof d.guild_id === 'string' ? d.guild_id : undefined;
		const user = d.user as { id?: string } | undefined;
		if (guildId && user?.id) {
			state.patchMember(guildId, user.id, {
				...('nick' in d ? { nick: d.nick as string | null } : {}),
				...(Array.isArray(d.roles) ? { roles: d.roles.map(String) } : {}),
				...('communication_disabled_until' in d
					? { communication_disabled_until: d.communication_disabled_until as string | null }
					: {}),
			});
		}
	},
	CHANNEL_CREATE: (state, d) => state.addChannel(typeof d.guild_id === 'string' ? d.guild_id : undefined, d),
	CHANNEL_DELETE: (state, d) => {
		if (typeof d.id === 'string') state.removeChannel(d.id);
	},
	MESSAGE_CREATE: (state, d) => {
		if (typeof d.channel_id === 'string') state.addMessage(d.channel_id, d);
	},
	MESSAGE_DELETE: (state, d) => {
		if (typeof d.channel_id === 'string' && typeof d.id === 'string') state.deleteMessage(d.channel_id, d.id);
	},
	MESSAGE_REACTION_ADD: (state, d) => {
		const emoji = emojiKey(d.emoji);
		if (typeof d.channel_id === 'string' && typeof d.message_id === 'string' && typeof d.user_id === 'string' && emoji)
			state.addReaction(d.channel_id, d.message_id, emoji, d.user_id);
	},
	MESSAGE_REACTION_REMOVE: (state, d) => {
		const emoji = emojiKey(d.emoji);
		if (typeof d.channel_id === 'string' && typeof d.message_id === 'string' && typeof d.user_id === 'string' && emoji)
			state.removeReaction(d.channel_id, d.message_id, emoji, d.user_id);
	},
	MESSAGE_REACTION_REMOVE_ALL: (state, d) => {
		if (typeof d.channel_id === 'string' && typeof d.message_id === 'string')
			state.removeAllReactions(d.channel_id, d.message_id);
	},
	MESSAGE_REACTION_REMOVE_EMOJI: (state, d) => {
		const emoji = emojiKey(d.emoji);
		if (typeof d.channel_id === 'string' && typeof d.message_id === 'string' && emoji)
			state.removeEmojiReactions(d.channel_id, d.message_id, emoji);
	},
	VOICE_STATE_UPDATE: (state, d) => state.setVoiceState(d),
	THREAD_CREATE: (state, d) => state.addChannel(typeof d.guild_id === 'string' ? d.guild_id : undefined, d),
	THREAD_DELETE: (state, d) => {
		if (typeof d.id === 'string') state.removeChannel(d.id);
	},
};

export const WORLD_EVENT_NAMES = Object.keys(WORLD_EVENT_MUTATORS) as readonly string[];

export function applyWorldEvent(state: WorldState, name: string, d: Record<string, unknown>): void {
	WORLD_EVENT_MUTATORS[name as WorldEmitEvent]?.(state, d);
}
