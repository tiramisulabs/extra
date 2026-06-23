import {
	type MockChannel,
	type MockGuild,
	type MockMember,
	type MockUser,
	mockChannel,
	mockGuild,
	mockMember,
	mockUser,
} from './factories';
import { type EmbedView, harvestComponents, type InteractiveComponentView, normalizeEmbed } from './bot/state';
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

function lastComponentsFrom(responses: MockContextResponse[]): InteractiveComponentView[] {
	const last = responses.at(-1);
	if (!last || typeof last === 'string') return [];
	const rows = (last as { components?: unknown }).components;
	if (!Array.isArray(rows)) return [];
	// Normalize each stored ActionRow builder (its toJSON recurses into children), then flatten to leaf components.
	return harvestComponents(rows.map(normalizeBuilder)).components;
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

export interface ReplyView {
	content?: string;
	embeds: EmbedView[];
	components: InteractiveComponentView[];
	flags?: number;
}

function lastReplyFrom(responses: MockContextResponse[]): ReplyView {
	const last = responses.at(-1);
	if (last === undefined) {
		throw new TypeError('lastReply: no responses were captured — the handler never replied.');
	}
	if (typeof last === 'string') return { content: last, embeds: [], components: [] };
	const content = (last as { content?: unknown }).content;
	const flags = (last as { flags?: unknown }).flags;
	return {
		...(typeof content === 'string' ? { content } : {}),
		embeds: lastEmbedsFrom(responses),
		components: lastComponentsFrom(responses),
		...(typeof flags === 'number' ? { flags } : {}),
	};
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
	channel?: MockChannel;
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
	/**
	 * The last reply as one typed object: `content` plus normalized `embeds`/`components` (and `flags`). The
	 * fluid front door for assertions — no casts, no optional chains. THROWS when no response was captured.
	 */
	lastReply(): ReplyView;
	/**
	 * Run a command/component/modal's `run()` against this mock (skips the pipeline; the cast lives here,
	 * not in your test). Only the context is passed, so a command that reads a second `run()` argument
	 * should use the mock bot instead.
	 */
	run(command: { run(...args: any[]): unknown }): Promise<unknown>;
}

export interface MockInteractionContextOptions {
	userId?: string;
	guildId?: string;
	channelId?: string;
	locale?: string;
	guildLocale?: string;
	author?: MockUser;
	guild?: MockGuild | null;
	channel?: MockChannel;
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
	/**
	 * The last reply as one typed object: `content` plus normalized `embeds`/`components` (and `flags`). The
	 * fluid front door for assertions — no casts, no optional chains. THROWS when no response was captured.
	 */
	lastReply(): ReplyView;
	/**
	 * Run a command/component/modal's `run()` against this mock (skips the pipeline; the cast lives here,
	 * not in your test). Only the context is passed, so a command that reads a second `run()` argument
	 * should use the mock bot instead.
	 */
	run(command: { run(...args: any[]): unknown }): Promise<unknown>;
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

function mockInteractionBase(options: MockInteractionContextOptions = {}): MockInteractionContextBase {
	const author = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const guildId = guild?.id;
	const channel = options.channel ?? mockChannel({ id: options.channelId, guildId: guildId ?? null });
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
		responses.push(response);
		return response;
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
		lastReply() {
			return lastReplyFrom(responses);
		},
		async run(command) {
			return command.run(this as never);
		},
	};
}

export function mockCommandContext<TOptions extends Record<string, unknown> = Record<string, unknown>>(
	options: MockCommandContextOptions<TOptions> = {},
): MockCommandContext<TOptions> {
	const author = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const guildId = guild?.id;
	const channel = options.channel ?? mockChannel({ id: options.channelId, guildId: guildId ?? null });
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
		responses.push(response);
		return response;
	};

	return {
		command: { name: options.commandName ?? 'test' },
		fullCommandName: options.fullCommandName ?? options.commandName ?? 'test',
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
		options: options.options ?? ({} as TOptions),
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
		lastReply() {
			return lastReplyFrom(responses);
		},
		async run(command) {
			return command.run(this as never);
		},
	};
}

export function mockComponentContext(options: MockComponentContextOptions = {}): MockComponentContext {
	const base = mockInteractionBase(options);
	const customId = options.customId ?? 'test-component';
	const componentType = options.componentType ?? 'Button';
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
	};
}

export function mockModalContext(options: MockModalContextOptions = {}): MockModalContext {
	const base = mockInteractionBase(options);
	const customId = options.customId ?? 'test-modal';
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
export function mockScene<TOptions extends Record<string, unknown> = Record<string, unknown>>(
	options: MockCommandContextOptions<TOptions> = {},
): MockScene<TOptions> {
	const user = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const channel = options.channel ?? mockChannel({ id: options.channelId, guildId: guild ? guild.id : null });
	const member = guild ? (options.member ?? mockMember({ user })) : null;
	const ctx = mockCommandContext<TOptions>({
		...options,
		author: user,
		guild,
		channel,
		member: member ?? undefined,
	});
	return { user, guild, channel, member, ctx };
}
