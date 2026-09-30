import type {
	Checkpoint,
	CommandSchema,
	Expectation,
	HostInfo,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	ProjectDescription,
	VisibleMessage as ProtocolVisibleMessage,
	SessionDescription,
	SessionLog,
} from '@slipher/lab/protocol';

export type { HostInfo, JsonValue, LabAction, ProjectDescription, SessionDescription };

export interface ComponentPayload {
	type: number;
	id?: number;
	components?: ComponentPayload[];
	component?: ComponentPayload;
	accessory?: ComponentPayload;
	content?: string;
	label?: string;
	description?: string;
	custom_id?: string;
	style?: number;
	disabled?: boolean;
	emoji?: { name?: string; id?: string; animated?: boolean };
	url?: string;
	placeholder?: string;
	options?: {
		label: string;
		value: string;
		default?: boolean;
		description?: string;
		emoji?: { name?: string; id?: string; animated?: boolean };
	}[];
	min_values?: number;
	max_values?: number;
	required?: boolean;
	min_length?: number;
	max_length?: number;
	value?: string;
	media?: { url: string };
	items?: { media?: { url: string }; description?: string }[];
	file?: { url: string };
	color?: number;
	divider?: boolean;
	spacing?: number;
}
export interface MessagePayload {
	id?: string;
	content?: string;
	flags?: number;
	components?: ComponentPayload[];
	embeds?: {
		title?: string;
		description?: string;
		color?: number;
		url?: string;
		fields?: { name: string; value: string; inline?: boolean }[];
		footer?: { text: string; icon_url?: string };
		author?: { name: string; url?: string; icon_url?: string };
		thumbnail?: { url: string };
		image?: { url: string };
		timestamp?: string;
	}[];
	author?: { id?: string; username?: string; global_name?: string | null; avatar?: string | null; bot?: boolean };
	timestamp?: string;
}
export type VisibleMessage = Omit<ProtocolVisibleMessage, 'payload'> & { payload: MessagePayload; deferred?: boolean };
export interface ModalPayload {
	custom_id: string;
	title: string;
	components: ComponentPayload[];
}
export interface PendingModalSource {
	channelId?: string;
	messageId?: string;
	customId?: string;
	values?: string[];
	commandName?: string;
	group?: string;
	subcommand?: string;
	options?: JsonValue;
}
export interface PendingModal {
	userId: string;
	interactionId?: string;
	customId: string;
	payload: ModalPayload;
	/** Closed by its user; the bot is still waiting and the original trigger reopens it. */
	closed?: boolean;
	/** What opened it; only this exact trigger reopens it. */
	source?: PendingModalSource;
}
export type CommandOption = NonNullable<CommandSchema['options']>[number];
export interface InspectorEntry {
	id: string;
	label: string;
	detail?: string;
	failed?: boolean;
}
export interface LabSnapshot {
	connection: 'connecting' | 'connected' | 'disconnected' | 'error';
	error?: string;
	/** Why the host stopped the previous session, shown until a new one starts. */
	notice?: string;
	project: ProjectDescription;
	session?: SessionDescription;
	scenarioId: string;
	params: Record<string, JsonValue>;
	actors: SessionDescription['actors'];
	channels: (SessionDescription['guilds'][number]['channels'][number] & { guildId: string })[];
	conversations: Record<string, { messages: VisibleMessage[]; diagnostics: string[] }>;
	commands: CommandSchema[];
	pending: { modals: PendingModal[]; collectors: InspectorEntry[] };
	closedModals?: string[];
	inspector: {
		actions: InspectorEntry[];
		rest: InspectorEntry[];
		world: InspectorEntry[];
		diagnostics: InspectorEntry[];
		project: InspectorEntry[];
	};
	log?: SessionLog;
	rawInspect?: InspectorSnapshot;
	projections?: Record<string, JsonValue>;
	names?: SessionDescription['names'];
	/** Host mode, build and this browser's run, when the client talks to a real host. */
	host?: HostInfo;
}
export type MessageIntent = { verb: 'click' | 'select'; customId: string; messageId: string; values?: string[] };
export interface LabClient {
	connect(): Promise<LabSnapshot>;
	subscribe(listener: (snapshot: LabSnapshot) => void): () => void;
	start(input: {
		scenarioId: string;
		params: Record<string, JsonValue>;
		services: Record<string, string>;
	}): Promise<void>;
	act(action: LabAction): Promise<void>;
	closeModal(actor: string, customId: string): void;
	/** Shows a closed modal again; the bot never learned it was closed. */
	reopenModal?(key: string): void;
	/** Hides one of the actor's own ephemeral messages for that actor only. */
	dismissMessage?(actor: string, channel: string, message: VisibleMessage): Promise<void>;
	clearError(): void;
	listCheckpoints?(): Promise<string[]>;
	saveCheckpoint?(name: string, arrival: Expectation[]): Promise<Checkpoint>;
	loadCheckpoint?(name: string): Promise<Checkpoint>;
	/** Rejects with `code: 'revision-mismatch'` when the checkpoint was recorded on another build. */
	replayCheckpoint?(name: string, options?: { acceptRevision?: boolean }): Promise<void>;
	exportCheckpoint?(name: string, format: 'vitest' | 'node'): Promise<string>;
}
export type { Checkpoint, Expectation };
