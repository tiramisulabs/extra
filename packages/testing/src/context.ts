import type { ComponentCommand, ModalCommand } from 'seyfert';
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
	 * test). Command contexts bind the command at creation with `mockCommandContext(MyCommand)`. Component/modal
	 * class-first helpers return a harness whose `run(input)` returns the context it used.
	 * Throws if this context was built without a command.
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

export type MockComponentType = NonNullable<MockComponentContextOptions['componentType']>;

type MockNonButtonComponentType = Exclude<MockComponentType, 'Button'>;
type ExtractComponentType<C extends ComponentCommandClass> = Extract<
	InstanceType<C>['componentType'],
	MockComponentType
>;
type ComponentTypeOf<C extends ComponentCommandClass> = [ExtractComponentType<C>] extends [never]
	? MockComponentType
	: ExtractComponentType<C>;
type MockComponentContextOptionsFor<T extends MockComponentType> = Omit<
	MockComponentContextOptions,
	'componentType'
> & {
	componentType?: T;
};

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
	 * test). Command contexts bind the command at creation with `mockCommandContext(MyCommand)`. Component/modal
	 * class-first helpers return a harness whose `run(input)` returns the context it used.
	 * Throws if this context was built without a command.
	 */
	run(): Promise<unknown>;
}

export interface MockComponentContext<T extends MockComponentType = 'Button'> extends MockInteractionContextBase {
	customId: string;
	componentType: T;
	interaction: {
		customId: string;
		custom_id: string;
		componentType: T;
		values: string[];
	};
	deferredUpdate: boolean;
	update(response: MockContextResponse): Promise<MockContextResponse>;
	deferUpdate(): Promise<void>;
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
}

type MockComponentContextInput<T extends MockComponentType> =
	| MockComponentContext<T>
	| MockComponentContextOptionsFor<T>;

export interface MockComponentContextHarness<T extends MockComponentType = 'Button'> {
	filter(input?: MockComponentContextInput<T>): Promise<boolean>;
	run(input?: MockComponentContextInput<T>): Promise<MockComponentContext<T>>;
}

type MockModalContextInput = MockModalContext | MockModalContextOptions;

export interface MockModalContextHarness {
	filter(input?: MockModalContextInput): Promise<boolean>;
	run(input?: MockModalContextInput): Promise<MockModalContext>;
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
	const member = guild ? (options.member ?? mockMember({ user: author, guildId: guild.id })) : null;
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
						'step-by-step with await bot.slash(...) + await bot.clickButton(id).',
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
						'e.g. mockCommandContext(MyCommand). For components/modals use the class-first harness — ' +
						'e.g. const button = mockComponentContext(MyButton); await button.run(input).',
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

function isMockInteractionContext(value: unknown): value is MockInteractionContextBase {
	return (
		typeof value === 'object' && value !== null && 'responses' in value && 'write' in value && 'lastResponse' in value
	);
}

function isMockComponentContext(value: unknown): value is MockComponentContext<MockComponentType> {
	return isMockInteractionContext(value) && 'customId' in value && 'componentType' in value && 'interaction' in value;
}

function isMockModalContext(value: unknown): value is MockModalContext {
	return isMockInteractionContext(value) && 'customId' in value && 'components' in value && 'interaction' in value;
}

function matchesCustomId(expected: unknown, actual: string): boolean {
	if (expected === undefined) return true;
	if (typeof expected === 'string') return expected === actual;
	if (expected instanceof RegExp) {
		expected.lastIndex = 0;
		return expected.test(actual);
	}
	return true;
}

function assertComponentTypeMatches(
	actual: MockComponentType | undefined,
	expected: MockComponentType,
	commandName: string,
) {
	if (actual && actual !== expected) {
		throw new TypeError(
			`mockComponentContext(${commandName}): componentType "${actual}" does not match the command componentType "${expected}".`,
		);
	}
}

function createMockComponentContext<T extends MockComponentType>(
	options: MockComponentContextOptionsFor<T> = {},
	defaults: { customId?: string; componentType?: T } = {},
): MockComponentContext<T> {
	const base = mockInteractionBase(options);
	const customId = options.customId ?? defaults.customId ?? 'test-component';
	const componentType = (options.componentType ?? defaults.componentType ?? 'Button') as T;
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
	} as MockComponentContext<T>;
}

function createMockComponentHarness<C extends ComponentCommandClass>(
	command: C,
): MockComponentContextHarness<ComponentTypeOf<C>> {
	const instance = new command();
	const componentType = (instance.componentType ?? 'Button') as ComponentTypeOf<C>;
	const defaultCustomId = typeof instance.customId === 'string' ? instance.customId : undefined;
	const commandName = command.name || 'ComponentCommand';
	const makeContext = (input?: MockComponentContextInput<ComponentTypeOf<C>>) => {
		if (isMockComponentContext(input)) {
			assertComponentTypeMatches(input.componentType, componentType, commandName);
			return input as MockComponentContext<ComponentTypeOf<C>>;
		}
		const options = input ?? {};
		assertComponentTypeMatches(options.componentType, componentType, commandName);
		return createMockComponentContext(options, { customId: defaultCustomId, componentType });
	};

	return {
		async filter(input) {
			const ctx = makeContext(input);
			if (!matchesCustomId(instance.customId, ctx.customId)) return false;
			return typeof instance.filter === 'function' ? Boolean(await instance.filter(ctx as never)) : true;
		},
		async run(input) {
			const ctx = makeContext(input);
			if (typeof instance.run !== 'function') {
				throw new TypeError(`mockComponentContext(${commandName}).run(): command has no run() method.`);
			}
			await instance.run(ctx as never);
			return ctx;
		},
	};
}

// Class-first (preferred): derives defaults from the command class and lets filter/run create the context they use.
export function mockComponentContext<C extends ComponentCommandClass>(
	command: C,
): MockComponentContextHarness<ComponentTypeOf<C>>;
// Object-form: creates a raw component context. No `componentType` means a button context.
export function mockComponentContext(
	options?: MockComponentContextOptionsFor<'Button'>,
): MockComponentContext<'Button'>;
export function mockComponentContext<T extends MockNonButtonComponentType>(
	options: MockComponentContextOptionsFor<T> & { componentType: T },
): MockComponentContext<T>;
export function mockComponentContext(
	commandOrOptions: ComponentCommandClass | MockComponentContextOptions = {},
	_legacyOptions?: MockComponentContextOptions,
): MockComponentContextHarness<MockComponentType> | MockComponentContext<MockComponentType> {
	const isClass = typeof commandOrOptions === 'function';
	if (isClass) {
		if (arguments.length > 1) {
			throw new TypeError(
				'mockComponentContext(ComponentClass, options) was removed. Use const component = ' +
					'mockComponentContext(ComponentClass); then component.filter(options) or await component.run(options).',
			);
		}
		return createMockComponentHarness(commandOrOptions as ComponentCommandClass);
	}

	return createMockComponentContext(commandOrOptions as MockComponentContextOptions);
}

function createMockModalContext(
	options: MockModalContextOptions = {},
	defaults: { customId?: string } = {},
): MockModalContext {
	const base = mockInteractionBase(options);
	const customId = options.customId ?? defaults.customId ?? 'test-modal';
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
	};
}

function createMockModalHarness<C extends ModalCommandClass>(command: C): MockModalContextHarness {
	const instance = new command();
	const defaultCustomId = typeof instance.customId === 'string' ? instance.customId : undefined;
	const commandName = command.name || 'ModalCommand';
	const makeContext = (input?: MockModalContextInput) =>
		isMockModalContext(input) ? input : createMockModalContext(input ?? {}, { customId: defaultCustomId });

	return {
		async filter(input) {
			const ctx = makeContext(input);
			if (!matchesCustomId(instance.customId, ctx.customId)) return false;
			return typeof instance.filter === 'function' ? Boolean(await instance.filter(ctx as never)) : true;
		},
		async run(input) {
			const ctx = makeContext(input);
			if (typeof instance.run !== 'function') {
				throw new TypeError(`mockModalContext(${commandName}).run(): command has no run() method.`);
			}
			await instance.run(ctx as never);
			return ctx;
		},
	};
}

// Class-first (preferred): derives defaults from the modal class and lets filter/run create the context they use.
export function mockModalContext<C extends ModalCommandClass>(command: C): MockModalContextHarness;
// Object-form: creates a raw modal context.
export function mockModalContext(options?: MockModalContextOptions): MockModalContext;
export function mockModalContext(
	commandOrOptions: ModalCommandClass | MockModalContextOptions = {},
	_legacyOptions?: MockModalContextOptions,
): MockModalContextHarness | MockModalContext {
	const isClass = typeof commandOrOptions === 'function';
	if (isClass) {
		if (arguments.length > 1) {
			throw new TypeError(
				'mockModalContext(ModalClass, options) was removed. Use const modal = mockModalContext(ModalClass); ' +
					'then modal.filter(options) or await modal.run(options).',
			);
		}
		return createMockModalHarness(commandOrOptions as ModalCommandClass);
	}

	return createMockModalContext(commandOrOptions as MockModalContextOptions);
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
	const member = guild ? (options.member ?? mockMember({ user, guildId: guild.id })) : null;
	const sceneOptions = { ...options, author: user, guild, channel, member: member ?? undefined };
	const ctx = isClass
		? mockCommandContext(commandOrOptions as SlashCommandClass, sceneOptions)
		: mockCommandContext(sceneOptions);
	return { user, guild, channel, member, ctx };
}
