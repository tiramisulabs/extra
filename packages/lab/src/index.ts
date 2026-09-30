import type {
	ApiUser,
	BotUserOptions,
	CommandSchema,
	MockBot,
	MockBotOptions,
	VisibleConversation,
	WorldBuilder,
} from '@slipher/testing';
import type { JsonValue, PROTOCOL_VERSION } from './protocol';

export type { JsonValue, VisibleConversation };
export type Params = Record<string, boolean | string | number>;
export interface ParamDefinition<T extends boolean | string | number = boolean | string | number> {
	kind: 'boolean' | 'string' | 'number' | 'enum';
	default: T;
	label?: string;
	values?: readonly T[];
}
export const param = {
	boolean: (options: { default: boolean; label?: string }): ParamDefinition<boolean> => ({
		kind: 'boolean',
		...options,
	}),
	string: (options: { default: string; label?: string }): ParamDefinition<string> => ({ kind: 'string', ...options }),
	number: (options: { default: number; label?: string }): ParamDefinition<number> => ({ kind: 'number', ...options }),
	enum: <T extends string>(options: { default: T; values: readonly T[]; label?: string }): ParamDefinition<T> => ({
		kind: 'enum',
		...options,
	}),
};
export type Ref = (name: string, override?: string) => string;
export type Refs = Readonly<Record<string, string>>;
export interface ScenarioWorld {
	builder: WorldBuilder;
	ref: Ref;
	bot(options?: BotUserOptions): ApiUser;
	guild(name: string, options?: Parameters<WorldBuilder['registerGuild']>[0]): string;
	role(name: string, guild: string, options?: Parameters<WorldBuilder['registerRole']>[1]): string;
	channel(name: string, guild: string, options?: Parameters<WorldBuilder['registerChannel']>[1]): string;
	member(name: string, guild: string, options?: Parameters<WorldBuilder['registerMember']>[1]): string;
	message(name: string, channel: string, options?: Parameters<WorldBuilder['registerMessage']>[1]): string;
}
export interface Scenario<R = unknown> {
	id: string;
	version: number;
	title: string;
	params?: Record<string, ParamDefinition>;
	world?: (world: ScenarioWorld, ctx: { params: Params; ref: Ref }) => void;
	actors?: (refs: Refs) => Record<string, ActorSpec>;
	requires?: (ctx: ScenarioContext<R>) => string[] | Promise<string[]>;
	seed?: (ctx: ScenarioContext<R>) => void | Promise<void>;
}
/** Ref names or IDs for the user an actor plays and the channel its actions default to. */
export interface ActorSpec {
	userId: string;
	guildId?: string;
	channelId: string;
}
export interface ScenarioContext<R = unknown> {
	params: Params;
	refs: Refs;
	resources: R;
	services: Readonly<Record<string, string>>;
}
export interface Project<R = unknown> {
	name: string;
	scenarios: Scenario<R>[];
	configure?: () => void | Promise<void>;
	resources?: {
		setup: (ctx: { preset: Preset }) => R | Promise<R>;
		dispose: (resources: R) => void | Promise<void>;
	};
	bot?: (ctx: { world: WorldBuilder; resources: R }) => MockBotOptions | MockBot | Promise<MockBotOptions | MockBot>;
	services?: Record<
		string,
		{ default: string; variants: Record<string, (ctx: ScenarioContext<R>) => void | Promise<void>> }
	>;
	inspect?: Record<string, (ctx: ScenarioContext<R>, args: JsonValue) => JsonValue | Promise<JsonValue>>;
}
export function defineScenario<R = unknown>(scenario: Scenario<R>): Scenario<R> {
	return scenario;
}
export function defineProject<R = unknown>(project: Project<R>): Project<R> {
	return project;
}
/** A type alias rather than an interface so a preset is assignable to `JsonValue`. */
export type Preset = {
	scenario: { id: string; version: number };
	params?: Params;
	services?: Record<string, string>;
	refs?: Record<string, string>;
};
export interface Locator {
	channel: string;
	messageRef?: string;
	customId?: string;
	contains?: string;
	author?: 'bot' | string;
}
export type LabAction =
	| {
			kind: 'user';
			actor: string;
			verb: 'slash';
			command: string;
			channel?: string;
			group?: string;
			subcommand?: string;
			options?: JsonValue;
	  }
	| { kind: 'user'; actor: string; verb: 'click'; customId: string; source: Locator }
	| { kind: 'user'; actor: string; verb: 'select'; customId: string; values: string[]; source: Locator }
	| {
			kind: 'user';
			actor: string;
			verb: 'submitModal';
			customId: string;
			channel?: string;
			fields: Record<string, string | string[]>;
	  }
	| { kind: 'admin'; op: 'addRole' | 'removeRole'; guild: string; member: string; role: string }
	| { kind: 'local'; op: 'closeModal' | 'reopenModal'; actor: string; customId: string }
	| { kind: 'local'; op: 'dismissMessage'; actor: string; source: Locator };
export interface ActionOutcome {
	ok: boolean;
	error?: string;
	dispatchIds: number[];
	summary: string;
}
export interface SessionLog {
	labVersion: string;
	protocolVersion: typeof PROTOCOL_VERSION;
	preset: Preset;
	entries: { seq: number; action: LabAction; outcome: ActionOutcome }[];
}
export type Expectation =
	| { path: string; equals: JsonValue }
	| { view: { actor: string; channel: string }; contains: string; absent?: false }
	| { view: { actor: string; channel: string }; contains: string; absent: true }
	| { role: { guild: string; member: string; role: string }; present: boolean }
	| { project: { name: string; args?: JsonValue; path: string }; equals: JsonValue }
	| { action: number; ok: boolean; error?: string };
export interface ExpectedOutcome {
	action: number;
	ok: boolean;
	error?: string;
	dispatchCount?: number;
}
export interface Checkpoint {
	version: 1;
	labVersion: string;
	protocolVersion: typeof PROTOCOL_VERSION;
	name: string;
	projectModule?: string;
	build?: { revision: string };
	preset: Preset;
	actions: LabAction[];
	outcomes?: ExpectedOutcome[];
	arrival: Expectation[];
}
export interface InspectorSnapshot {
	world: JsonValue;
	rest: JsonValue;
	pending: JsonValue;
	diagnostics: string[];
	local?: { dismissed: Record<string, string[]> };
}
export interface SessionDescription {
	preset: Preset;
	refs: Record<string, string>;
	actors: {
		key: string;
		userId: string;
		name: string;
		guildId?: string;
		channelId: string;
		roles: Record<string, string[]>;
	}[];
	guilds: {
		id: string;
		name: string;
		roles: { id: string; name: string; position: number; permissions: string }[];
		members: { id: string; name: string; bot: boolean }[];
		channels: { id: string; name: string; type: number; visibleTo: string[] }[];
	}[];
	names: { users: Record<string, string>; roles: Record<string, string>; channels: Record<string, string> };
}
export type SessionEvent =
	| { type: 'started' | 'action' | 'disposed'; detail?: JsonValue }
	| { type: 'error'; origin?: 'observer' | 'session' | 'child'; detail: JsonValue }
	| { type: 'rest'; phase: 'request' | 'settled'; detail: JsonValue }
	| { type: 'dispatch'; phase: 'start' | 'end'; detail: JsonValue }
	| { type: 'world' | 'interaction'; detail: JsonValue };
export interface Session {
	start(): Promise<void>;
	dispose(): Promise<void>;
	reset(): Promise<void>;
	act(action: LabAction): Promise<ActionOutcome>;
	observe(listener: (event: SessionEvent) => void): () => void;
	view(actor: string, channelRef: string): Promise<VisibleConversation>;
	inspect(): Promise<InspectorSnapshot>;
	describe(): Promise<SessionDescription>;
	commandSchemas(): Promise<CommandSchema[]>;
	inspectProject(name: string, args?: JsonValue): Promise<JsonValue>;
	log(): Promise<SessionLog>;
}
