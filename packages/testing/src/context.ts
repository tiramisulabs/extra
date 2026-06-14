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
