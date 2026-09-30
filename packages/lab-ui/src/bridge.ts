import type {
	Checkpoint,
	CommandSchema,
	Expectation,
	HostInfo,
	InspectorSnapshot,
	JsonValue,
	LabAction,
	ProjectDescription,
	PendingModal as ProtocolPendingModal,
	VisibleMessage as ProtocolVisibleMessage,
	SessionDescription,
	SessionLog,
} from '@slipher/lab/protocol';

export type { Expectation, JsonValue, LabAction, ProjectDescription };

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
export type VisibleMessage = Omit<ProtocolVisibleMessage, 'payload'> & { payload: MessagePayload };
interface ModalPayload {
	custom_id: string;
	title: string;
	components: ComponentPayload[];
}
export interface PendingModal extends Omit<ProtocolPendingModal, 'payload' | 'sessionKey'> {
	payload: ModalPayload;
	/** Closed by its user; the bot is still waiting and the original trigger reopens it. */
	closed?: boolean;
}
export type CommandOption = NonNullable<CommandSchema['options']>[number];
export interface InspectorEntry {
	id: string;
	label: string;
	/** Who performed a logged action; shown as a badge. */
	kind?: LabAction['kind'];
	detail?: string;
	failed?: boolean;
}
export type Guild = SessionDescription['guilds'][number];
export interface LabSnapshot {
	error?: string;
	/** Why the host stopped the previous session, shown until a new one starts. */
	notice?: string;
	project: ProjectDescription;
	/** Present while a session runs. */
	session?: SessionDescription;
	actors: SessionDescription['actors'];
	channels: (Guild['channels'][number] & { guildId: string })[];
	conversations: Record<string, { messages: VisibleMessage[]; diagnostics: string[] }>;
	commands: CommandSchema[];
	pending: { modals: PendingModal[]; collectors: InspectorEntry[] };
	/** Interaction IDs of pending modals hidden from their user. */
	closedModals: string[];
	inspector: {
		actions: InspectorEntry[];
		rest: InspectorEntry[];
		diagnostics: InspectorEntry[];
	};
	log?: SessionLog;
	rawInspect?: InspectorSnapshot;
	projections?: Record<string, JsonValue>;
	/** Host mode, build and this browser's run, when the client talks to a real host. */
	host?: HostInfo;
}
type ParamValue = boolean | string | number;
/** What Start sends: a scenario of the project's catalogue with its parameters and service variants. */
export interface ScenarioChoice {
	scenarioId: string;
	/** `null` is an emptied number field. */
	params: Record<string, ParamValue | null>;
	services: Record<string, string>;
}
/** The preset's parameters: emptied fields are left out so the scenario's defaults apply. */
export function presetParams(choice: ScenarioChoice): Record<string, ParamValue> {
	const params: Record<string, ParamValue> = {};
	for (const [name, value] of Object.entries(choice.params)) if (value !== null) params[name] = value;
	return params;
}
export type MessageIntent = { verb: 'click' | 'select'; customId: string; messageId: string; values?: string[] };
export interface LabClient {
	connect(): Promise<LabSnapshot>;
	subscribe(listener: (snapshot: LabSnapshot) => void): () => void;
	start(choice: ScenarioChoice): Promise<void>;
	act(action: LabAction): Promise<void>;
	closeModal(actor: string, customId: string): void;
	/** Shows a closed modal again; the bot never learned it was closed. */
	reopenModal(key: string): void;
	/** Hides one of the actor's own ephemeral messages for that actor only. */
	dismissMessage(actor: string, channel: string, message: VisibleMessage): Promise<void>;
	clearError(): void;
}
/** Saved checkpoints live on a lab host; a client without one cannot offer them. */
export interface CheckpointClient {
	listCheckpoints(): Promise<string[]>;
	saveCheckpoint(name: string, arrival: Expectation[]): Promise<Checkpoint>;
	loadCheckpoint(name: string): Promise<Checkpoint>;
	/** Rejects with `code: 'revision-mismatch'` when the checkpoint was recorded on another build. */
	replayCheckpoint(name: string, options?: { acceptRevision?: boolean }): Promise<void>;
	exportCheckpoint(name: string, format: 'vitest' | 'node'): Promise<string>;
}
export const hasCheckpoints = (client: LabClient): client is LabClient & CheckpointClient => 'saveCheckpoint' in client;
