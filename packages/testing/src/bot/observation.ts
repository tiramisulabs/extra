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

export interface PendingModal {
	userId: string;
	sessionKey?: string;
	interactionId: string;
	customId: string;
	payload: APIModalInteractionResponseCallbackData;
	source?: {
		channelId?: string;
		messageId?: string;
		customId?: string;
		values?: string[];
		commandName?: string;
		group?: string;
		subcommand?: string;
		options?: JsonValue;
	};
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
