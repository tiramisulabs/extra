import type { ComponentCommand, ComponentContext, ModalCommand, ModalContext } from 'seyfert';
import type { SlashCommandClass, SlashOptionsOf } from './bot/bot';
import { type EmbedView, harvestComponents, type InteractiveComponentView, normalizeEmbed } from './bot/state';
import {
	type MockChannel,
	type MockChannelOptions,
	type MockGuild,
	type MockMember,
	type MockUser,
	mockChannel,
	mockGuild,
	mockMember,
	mockUser,
} from './factories';
import {
	type MockClient,
	type MockLogger,
	type MockQueues,
	type MockScheduler,
	mockClient,
	mockLogger,
	mockQueues,
	mockScheduler,
} from './stubs';

export type MockContextResponse = Record<string, unknown> | string;

/** A concrete `ComponentCommand` subclass — the class-first arg of {@link mockComponentContext}. */
export type ComponentCommandClass = new () => ComponentCommand;
/** A concrete `ModalCommand` subclass — the class-first arg of {@link mockModalContext}. */
export type ModalCommandClass = new () => ModalCommand;

/** A command/component/modal instance bound to a context so `ctx.run()` needs no argument. `any[]` mirrors the
 *  prior ctx.run signature so a handler whose `run` takes a typed ctx (or extra params) stays assignable; `run?`
 *  tolerates seyfert typing `Command.run` as possibly-undefined (it always exists on a constructed instance). */
type RunnableCommand = { run?(...args: any[]): unknown };

/** Normalize a stored seyfert builder (Embed, ActionRow, …) to plain data — its fields live under `.toJSON()`. */
function normalizeBuilder(value: unknown): Record<string, unknown> {
	if (value && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
		return (value as { toJSON(): Record<string, unknown> }).toJSON();
	}
	return value as Record<string, unknown>;
}

function responseEmbeds(response: MockContextResponse | undefined): unknown[] {
	if (!response || typeof response === 'string') return [];
	const embeds = (response as { embeds?: unknown }).embeds;
	return Array.isArray(embeds) ? embeds : [];
}

function lastEmbedsFrom(responses: MockContextResponse[]): EmbedView[] {
	return responseEmbeds(responses.at(-1)).map(normalizeEmbed);
}

function allEmbedsFrom(responses: MockContextResponse[]): EmbedView[] {
	return responses.flatMap(response => responseEmbeds(response).map(normalizeEmbed));
}

// Stored ActionRow builders, normalized via toJSON (which recurses into children) so harvestComponents can flatten.
function responseComponentRows(response: MockContextResponse | undefined): unknown[] {
	if (!response || typeof response === 'string') return [];
	const rows = (response as { components?: unknown }).components;
	return Array.isArray(rows) ? rows.map(normalizeBuilder) : [];
}

function lastComponentsFrom(responses: MockContextResponse[]): InteractiveComponentView[] {
	return harvestComponents(responseComponentRows(responses.at(-1))).components;
}

function allComponentsFrom(responses: MockContextResponse[]): InteractiveComponentView[] {
	return responses.flatMap(response => harvestComponents(responseComponentRows(response)).components);
}

function lastTextsFrom(responses: MockContextResponse[]): string[] {
	return harvestComponents(responseComponentRows(responses.at(-1))).textDisplays;
}

function allTextsFrom(responses: MockContextResponse[]): string[] {
	return responses.flatMap(response => harvestComponents(responseComponentRows(response)).textDisplays);
}

function lastEmbedFrom(responses: MockContextResponse[], index: number): EmbedView {
	if (responses.length === 0) {
		throw new TypeError('lastEmbed: no responses were captured — the handler never replied.');
	}
	const embeds = responseEmbeds(responses.at(-1));
	if (embeds.length === 0) {
		throw new TypeError('lastEmbed: the last response has no embeds.');
	}
	if (index < 0 || index >= embeds.length) {
		throw new TypeError(`lastEmbed: index ${index} is out of range — the last response has ${embeds.length} embed(s).`);
	}
	return normalizeEmbed(embeds[index]);
}

export interface MockCommandContextOptions<TOptions extends Record<string, unknown> = Record<string, unknown>> {
	commandName?: string;
	fullCommandName?: string;
	userId?: string;
	guildId?: string;
	channelId?: string;
	locale?: string;
	guildLocale?: string;
	author?: MockUser;
	guild?: MockGuild | null;
	channel?: MockChannelOptions;
	member?: MockMember;
	options?: TOptions;
	metadata?: Record<string, unknown>;
	logger?: MockLogger;
	queues?: MockQueues;
	scheduler?: MockScheduler;
	client?: MockClient;
	botId?: string;
	applicationId?: string;
}

export interface MockCommandContext<TOptions extends Record<string, unknown> = Record<string, unknown>> {
	command: { name: string };
	fullCommandName: string;
	client: MockClient;
	author: MockUser;
	user: MockUser;
	guildId?: string;
	channelId: string;
	locale: string;
	guildLocale?: string;
	guild(): Promise<MockGuild | null>;
	channel(): Promise<MockChannel>;
	me(): Promise<MockMember | null>;
	member: MockMember | null;
	options: TOptions;
	metadata: Record<string, unknown>;
	logger: MockLogger;
	queues: MockQueues;
	scheduler: MockScheduler;
	responses: MockContextResponse[];
	write(response: MockContextResponse): Promise<MockContextResponse>;
	editOrReply(response: MockContextResponse): Promise<MockContextResponse>;
	followup(response: MockContextResponse): Promise<MockContextResponse>;
	deferReply(): Promise<void>;
	clearResponses(): void;
	lastResponse(): MockContextResponse | undefined;
	/**
	 * The last response's embed at `index`, normalized to plain data (Discord API shape) so reading
	 * `.title`/`.description` works even when the handler passed a seyfert `Embed` builder (whose fields live
	 * under `.toJSON()`). THROWS when there is no response, no embed, or the index is out of range — it never
	 * returns `undefined`, so a typo can't make an assertion pass vacuously.
	 */
	lastEmbed(index?: number): EmbedView;
	/** All embeds of the last response, normalized to a typed {@link EmbedView}; `[]` when the last response has none. */
	lastEmbeds(): EmbedView[];
	/**
	 * All interactive components (buttons/selects) of the last response, flattened from its action rows and
	 * normalized to plain data; `[]` when the last response has none. Reading `.customId`/`.label`/`.disabled`/
	 * `.options` works even when the handler passed seyfert builders (whose fields live under `.toJSON()`).
	 */
	lastComponents(): InteractiveComponentView[];
	/** Components-v2 TextDisplay (type 10) contents of the last response; `[]` when none. */
	lastTexts(): string[];
	/** Every embed across ALL responses (not just the last), normalized — for flows whose embed isn't in the final reply. */
	allEmbeds(): EmbedView[];
	/** Every interactive component across ALL responses, flattened + normalized — e.g. a select rendered before a later timeout reply. */
	allComponents(): InteractiveComponentView[];
	/** Every Components-v2 TextDisplay (type 10) content across ALL responses. */
	allTexts(): string[];
	/**
	 * Run the bound command's `run()` against this mock (skips the pipeline; the cast lives here, not in your
	 * test). The command is bound at creation — `mockCommandContext(MyCommand)` / `mockComponentContext(MyButton)`
	 * / `mockModalContext(MyModal)` — so this takes no argument. Throws if the context was built without a command.
	 */
	run(): Promise<unknown>;
}

export interface MockInteractionContextOptions {
	userId?: string;
	guildId?: string;
	channelId?: string;
	locale?: string;
	guildLocale?: string;
	author?: MockUser;
	guild?: MockGuild | null;
	channel?: MockChannelOptions;
	member?: MockMember;
	metadata?: Record<string, unknown>;
	logger?: MockLogger;
	queues?: MockQueues;
	scheduler?: MockScheduler;
	client?: MockClient;
	botId?: string;
	applicationId?: string;
}

export interface MockComponentContextOptions extends MockInteractionContextOptions {
	customId?: string;
	componentType?: 'Button' | 'StringSelect' | 'UserSelect' | 'RoleSelect' | 'MentionableSelect' | 'ChannelSelect';
	values?: string[];
}

export interface MockModalContextOptions extends MockInteractionContextOptions {
	customId?: string;
	fields?: Record<string, string | string[]>;
}

export interface MockInteractionContextBase {
	client: MockClient;
	author: MockUser;
	user: MockUser;
	guildId?: string;
	channelId: string;
	locale: string;
	guildLocale?: string;
	guild(): Promise<MockGuild | null>;
	channel(): Promise<MockChannel>;
	me(): Promise<MockMember | null>;
	member: MockMember | null;
	metadata: Record<string, unknown>;
	logger: MockLogger;
	queues: MockQueues;
	scheduler: MockScheduler;
	responses: MockContextResponse[];
	write(response: MockContextResponse): Promise<MockContextResponse>;
	editOrReply(response: MockContextResponse): Promise<MockContextResponse>;
	followup(response: MockContextResponse): Promise<MockContextResponse>;
	deferReply(): Promise<void>;
	clearResponses(): void;
	lastResponse(): MockContextResponse | undefined;
	/**
	 * The last response's embed at `index`, normalized to plain data (Discord API shape) so reading
	 * `.title`/`.description` works even when the handler passed a seyfert `Embed` builder (whose fields live
	 * under `.toJSON()`). THROWS when there is no response, no embed, or the index is out of range — it never
	 * returns `undefined`, so a typo can't make an assertion pass vacuously.
	 */
	lastEmbed(index?: number): EmbedView;
	/** All embeds of the last response, normalized to a typed {@link EmbedView}; `[]` when the last response has none. */
	lastEmbeds(): EmbedView[];
	/**
	 * All interactive components (buttons/selects) of the last response, flattened from its action rows and
	 * normalized to plain data; `[]` when the last response has none. Reading `.customId`/`.label`/`.disabled`/
	 * `.options` works even when the handler passed seyfert builders (whose fields live under `.toJSON()`).
	 */
	lastComponents(): InteractiveComponentView[];
	/** Components-v2 TextDisplay (type 10) contents of the last response; `[]` when none. */
	lastTexts(): string[];
	/** Every embed across ALL responses (not just the last), normalized — for flows whose embed isn't in the final reply. */
	allEmbeds(): EmbedView[];
	/** Every interactive component across ALL responses, flattened + normalized — e.g. a select rendered before a later timeout reply. */
	allComponents(): InteractiveComponentView[];
	/** Every Components-v2 TextDisplay (type 10) content across ALL responses. */
	allTexts(): string[];
	/**
	 * Run the bound command's `run()` against this mock (skips the pipeline; the cast lives here, not in your
	 * test). The command is bound at creation — `mockCommandContext(MyCommand)` / `mockComponentContext(MyButton)`
	 * / `mockModalContext(MyModal)` — so this takes no argument. Throws if the context was built without a command.
	 */
	run(): Promise<unknown>;
}

export interface MockComponentContext extends MockInteractionContextBase {
	customId: string;
	componentType: NonNullable<MockComponentContextOptions['componentType']>;
	interaction: {
		customId: string;
		custom_id: string;
		componentType: NonNullable<MockComponentContextOptions['componentType']>;
		values: string[];
	};
	deferredUpdate: boolean;
	update(response: MockContextResponse): Promise<MockContextResponse>;
	deferUpdate(): Promise<void>;
	/**
	 * View this mock as a seyfert {@link ComponentContext} for passing to a `ComponentCommand`'s `filter`/`run`
	 * directly — `button.filter(ctx.asComponentContext())`. A typed cast: the mock is a friendly stand-in (string
	 * `componentType`, simplified `interaction`) that can't be structurally a `ComponentContext`, so this names the
	 * cast in one place instead of `as unknown as` in your test. Pass the component type (default `'Button'`) to
	 * type the returned context's interaction; the value drives only the type.
	 */
	asComponentContext<T extends NonNullable<MockComponentContextOptions['componentType']> = 'Button'>(
		type?: T,
	): ComponentContext<T>;
}

export interface MockModalContext extends MockInteractionContextBase {
	customId: string;
	components: { type: 18; component: { type: 4; customId: string; custom_id: string; value: string | string[] } }[];
	interaction: {
		customId: string;
		custom_id: string;
		components: MockModalContext['components'];
		getInputValue(customId: string, required: true): string | string[];
		getInputValue(customId: string, required?: false): string | string[] | undefined;
	};
	/**
	 * View this mock as a seyfert {@link ModalContext} for passing to a `ModalCommand`'s `run`/`filter` directly —
	 * `modal.run(ctx.asModalContext())`. A typed cast in one place; see {@link MockComponentContext.asComponentContext}.
	 */
	asModalContext(): ModalContext;
}

/**
 * Resolve the `channel` option to a full {@link MockChannel}. A partial ({@link MockChannelOptions}) is completed
 * via {@link mockChannel} (filling position/permission_overwrites/nsfw and spreading any `extra` stubs); an
 * already-built channel (detected by its output-only `position`) is returned as-is, preserving reference identity.
 */
function resolveChannelOption(input: MockChannelOptions | undefined, fallback: MockChannelOptions): MockChannel {
	if (input && 'position' in input) return input as MockChannel;
	return mockChannel({ ...fallback, ...input });
}

function mockInteractionBase(
	options: MockInteractionContextOptions = {},
	command?: RunnableCommand,
): MockInteractionContextBase {
	const author = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const guildId = guild?.id;
	const channel = resolveChannelOption(options.channel, { id: options.channelId, guildId: guildId ?? null });
	const member = guild ? (options.member ?? mockMember({ user: author })) : null;
	const logger = options.logger ?? options.client?.logger ?? mockLogger();
	const queues = options.queues ?? options.client?.queues ?? mockQueues();
	const scheduler = options.scheduler ?? options.client?.scheduler ?? mockScheduler();
	const client =
		options.client ??
		mockClient({
			logger,
			queues,
			scheduler,
			botId: options.botId,
			applicationId: options.applicationId,
		});
	const responses: MockContextResponse[] = [];
	const recordResponse = async (response: MockContextResponse) => {
		responses.push(response); // verbatim — the `responses` log is the contract; the wrapper below is non-enumerable
		if (typeof response === 'string') return response;
		const reply = { ...response };
		// Light unit harness has no component runtime: instead of a cryptic "createComponentCollector is not a
		// function", direct collector/confirm flows to the bot harness. Non-enumerable so it stays invisible to
		// deepEqual/spread of the returned reply.
		Object.defineProperty(reply, 'createComponentCollector', {
			value() {
				throw new TypeError(
					'createComponentCollector is not available on mockCommandContext (the light unit harness has no ' +
						'component runtime). For collector/confirm flows use createMockBot({ commands: [...] }) and drive them ' +
						'with bot.slash(...).untilComponent(id) + bot.clickButton(id).',
				);
			},
		});
		return reply;
	};

	return {
		client,
		author,
		user: author,
		guildId,
		channelId: channel.id,
		locale: options.locale ?? 'en-US',
		guildLocale: options.guildLocale ?? guild?.preferredLocale,
		async guild() {
			return guild;
		},
		async channel() {
			return channel;
		},
		async me() {
			return member;
		},
		member,
		metadata: options.metadata ?? {},
		logger,
		queues,
		scheduler,
		responses,
		write: recordResponse,
		editOrReply: recordResponse,
		followup: recordResponse,
		async deferReply() {},
		clearResponses() {
			responses.length = 0;
		},
		lastResponse() {
			return responses.at(-1);
		},
		lastEmbed(index = 0) {
			return lastEmbedFrom(responses, index);
		},
		lastEmbeds() {
			return lastEmbedsFrom(responses);
		},
		lastComponents() {
			return lastComponentsFrom(responses);
		},
		lastTexts() {
			return lastTextsFrom(responses);
		},
		allEmbeds() {
			return allEmbedsFrom(responses);
		},
		allComponents() {
			return allComponentsFrom(responses);
		},
		allTexts() {
			return allTextsFrom(responses);
		},
		async run() {
			if (typeof command?.run !== 'function') {
				throw new TypeError(
					'ctx.run(): no command bound to this context. Build it with its command class — ' +
						'e.g. mockCommandContext(MyCommand) / mockComponentContext(MyButton) / mockModalContext(MyModal).',
				);
			}
			return command.run(this as never);
		},
	};
}

/** Options for the class-first {@link mockCommandContext}: the context fields, with `options` typed to the command. */
export type CommandClassOptions<C extends SlashCommandClass> = Omit<MockCommandContextOptions, 'options'> & {
	options?: SlashOptionsOf<C>;
};

// Class-first (preferred): infers `options` from the command, derives the name from @Declare, binds `ctx.run()`.
export function mockCommandContext<C extends SlashCommandClass>(
	command: C,
	options?: CommandClassOptions<C>,
): MockCommandContext<SlashOptionsOf<C>>;
// Object-form (escape, no command): a response sink / identity-only context. `ctx.run()` throws (nothing bound).
export function mockCommandContext<TOptions extends Record<string, unknown> = Record<string, unknown>>(
	options?: MockCommandContextOptions<TOptions>,
): MockCommandContext<TOptions>;
export function mockCommandContext(
	commandOrOptions: SlashCommandClass | MockCommandContextOptions = {},
	classOptions?: MockCommandContextOptions,
): MockCommandContext {
	const isClass = typeof commandOrOptions === 'function';
	const instance = isClass ? new (commandOrOptions as SlashCommandClass)() : undefined;
	const options = (isClass ? classOptions : (commandOrOptions as MockCommandContextOptions)) ?? {};
	const name = options.commandName ?? instance?.name ?? 'test';
	// A command context is an interaction context plus command identity + typed options. Build on the shared base
	// (as the component/modal contexts do) so the response surface lives in exactly one place.
	return {
		...mockInteractionBase(options, instance),
		command: { name },
		fullCommandName: options.fullCommandName ?? name,
		options: options.options ?? {},
	};
}

// Class-first (preferred): derives componentType (+ customId when a plain string) from the class, binds ctx.run().
export function mockComponentContext<C extends ComponentCommandClass>(
	command: C,
	options?: MockComponentContextOptions,
): MockComponentContext;
// Object-form (escape, no command): ctx.run() throws (nothing bound).
export function mockComponentContext(options?: MockComponentContextOptions): MockComponentContext;
export function mockComponentContext(
	commandOrOptions: ComponentCommandClass | MockComponentContextOptions = {},
	classOptions?: MockComponentContextOptions,
): MockComponentContext {
	const isClass = typeof commandOrOptions === 'function';
	const instance = isClass ? new (commandOrOptions as ComponentCommandClass)() : undefined;
	const options = (isClass ? classOptions : (commandOrOptions as MockComponentContextOptions)) ?? {};
	const base = mockInteractionBase(options, instance);
	const customId = options.customId ?? (typeof instance?.customId === 'string' ? instance.customId : 'test-component');
	const componentType = options.componentType ?? instance?.componentType ?? 'Button';
	const values = options.values ?? [];
	let deferredUpdate = false;

	return {
		...base,
		customId,
		componentType,
		interaction: {
			customId,
			custom_id: customId,
			componentType,
			values,
		},
		get deferredUpdate() {
			return deferredUpdate;
		},
		async update(response: MockContextResponse) {
			return base.write(response);
		},
		async deferUpdate() {
			deferredUpdate = true;
		},
		asComponentContext<T extends NonNullable<MockComponentContextOptions['componentType']> = 'Button'>(
			_type?: T,
		): ComponentContext<T> {
			return this as unknown as ComponentContext<T>;
		},
	};
}

// Class-first (preferred): derives customId (when a plain string) from the class, binds ctx.run().
export function mockModalContext<C extends ModalCommandClass>(
	command: C,
	options?: MockModalContextOptions,
): MockModalContext;
// Object-form (escape, no command): ctx.run() throws (nothing bound).
export function mockModalContext(options?: MockModalContextOptions): MockModalContext;
export function mockModalContext(
	commandOrOptions: ModalCommandClass | MockModalContextOptions = {},
	classOptions?: MockModalContextOptions,
): MockModalContext {
	const isClass = typeof commandOrOptions === 'function';
	const instance = isClass ? new (commandOrOptions as ModalCommandClass)() : undefined;
	const options = (isClass ? classOptions : (commandOrOptions as MockModalContextOptions)) ?? {};
	const base = mockInteractionBase(options, instance);
	const customId = options.customId ?? (typeof instance?.customId === 'string' ? instance.customId : 'test-modal');
	const fields = options.fields ?? {};
	const components = Object.entries(fields).map(([fieldCustomId, value]) => ({
		type: 18 as const,
		component: { type: 4 as const, customId: fieldCustomId, custom_id: fieldCustomId, value },
	}));
	const getInputValue = (fieldCustomId: string, required?: boolean) => {
		const value = fields[fieldCustomId];
		if (value === undefined && required) {
			throw new TypeError(`mockModalContext: required field "${fieldCustomId}" is missing`);
		}
		return value;
	};

	return {
		...base,
		customId,
		components,
		interaction: {
			customId,
			custom_id: customId,
			components,
			getInputValue,
		},
		asModalContext(): ModalContext {
			return this as unknown as ModalContext;
		},
	};
}

export interface MockScene<TOptions extends Record<string, unknown> = Record<string, unknown>> {
	user: MockUser;
	guild: MockGuild | null;
	channel: MockChannel;
	member: MockMember | null;
	ctx: MockCommandContext<TOptions>;
}

/**
 * Build a consistently-wired set of entities plus a command context in one call: the channel belongs to the
 * guild, the member wraps the user, and `ctx` is built from all of them. Removes the boilerplate of threading
 * ids between `mockUser`/`mockGuild`/`mockChannel`/`mockMember` and `mockCommandContext`.
 */
export function mockScene<C extends SlashCommandClass>(
	command: C,
	options?: CommandClassOptions<C>,
): MockScene<SlashOptionsOf<C>>;
export function mockScene<TOptions extends Record<string, unknown> = Record<string, unknown>>(
	options?: MockCommandContextOptions<TOptions>,
): MockScene<TOptions>;
export function mockScene(
	commandOrOptions: SlashCommandClass | MockCommandContextOptions = {},
	classOptions?: MockCommandContextOptions,
): MockScene {
	const isClass = typeof commandOrOptions === 'function';
	const options = (isClass ? classOptions : (commandOrOptions as MockCommandContextOptions)) ?? {};
	const user = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const channel = resolveChannelOption(options.channel, { id: options.channelId, guildId: guild ? guild.id : null });
	const member = guild ? (options.member ?? mockMember({ user })) : null;
	const sceneOptions = { ...options, author: user, guild, channel, member: member ?? undefined };
	const ctx = isClass
		? mockCommandContext(commandOrOptions as SlashCommandClass, sceneOptions)
		: mockCommandContext(sceneOptions);
	return { user, guild, channel, member, ctx };
}
