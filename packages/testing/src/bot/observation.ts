import type {
	APIMessage,
	APIModalInteractionResponseCallbackData,
	RESTPostAPIApplicationCommandsJSONBody,
} from 'seyfert';
import type { RecordedAction } from './rest';
import type { WorldDiff } from './state';

export interface VisibleMessage {
	id: string;
	channelId: string;
	payload: APIMessage;
	visibility: 'public' | 'ephemeral';
	ownerId?: string;
	interactionId?: string;
	/** Monotonic creation order in this world. */
	sequence?: number;
	/** Whether the message existed when the mock bot started. Only set by inspectChannel. */
	isHistory?: boolean;
	/** User IDs that received this message when it was created. Only set by inspectChannel. */
	liveRecipientIds?: string[];
	editedAt?: string;
}

export interface VisibleConversation {
	channelId: string;
	messages: VisibleMessage[];
	diagnostics: string[];
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * What opened a modal, so two modals with the same customId stay distinguishable. Component openers carry the
 * message, customId and selected values; chat-input openers carry the command path and its options.
 */
export interface ModalOpenerSource {
	channelId?: string;
	messageId?: string;
	customId?: string;
	values?: string[];
	commandName?: string;
	group?: string;
	subcommand?: string;
	/** Leaf command options keyed by name, in name order. */
	options?: JsonValue;
}

export interface PendingModal {
	userId: string;
	sessionKey?: string;
	/** The interaction that opened the modal. */
	interactionId: string;
	customId: string;
	payload: APIModalInteractionResponseCallbackData;
	source?: ModalOpenerSource;
}

export interface PendingCollector {
	messageId: string;
	channelId?: string;
	customIds?: string[];
	kind: 'run' | 'waitFor';
}

export type PendingInteractionChange =
	| { kind: 'modal'; phase: 'opened' | 'closed'; modal: PendingModal }
	| { kind: 'collector'; phase: 'opened' | 'closed'; collector: PendingCollector };

export type MockBotEvent =
	| { type: 'rest'; phase: 'request' | 'settled'; action: RecordedAction }
	| { type: 'dispatch'; phase: 'start' | 'end'; dispatchId: number; kind: string; sessionKey?: string; error?: unknown }
	| { type: 'world'; diff: WorldDiff }
	| { type: 'interaction'; change: PendingInteractionChange };

export type CommandSchema = RESTPostAPIApplicationCommandsJSONBody;
