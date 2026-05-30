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
import { type MockLogger, type MockQueues, type MockScheduler, mockLogger, mockQueues, mockScheduler } from './stubs';

export type MockContextResponse = Record<string, unknown> | string;

export interface MockCommandContextOptions {
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
	options?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	logger?: MockLogger;
	queues?: MockQueues;
	scheduler?: MockScheduler;
}

export interface MockCommandContext {
	command: { name: string };
	fullCommandName: string;
	author: MockUser;
	user: MockUser;
	guildId?: string;
	channelId: string;
	locale: string;
	guildLocale?: string;
	guild: MockGuild | null;
	channel: MockChannel;
	member: MockMember | null;
	options: Record<string, unknown>;
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

export function mockCommandContext(options: MockCommandContextOptions = {}): MockCommandContext {
	const author = options.author ?? mockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? mockGuild({ id: options.guildId }));
	const guildId = guild?.id;
	const channel = options.channel ?? mockChannel({ id: options.channelId, guildId: guildId ?? null });
	const responses: MockContextResponse[] = [];
	const recordResponse = async (response: MockContextResponse) => {
		responses.push(response);
		return response;
	};

	return {
		command: { name: options.commandName ?? 'test' },
		fullCommandName: options.fullCommandName ?? options.commandName ?? 'test',
		author,
		user: author,
		guildId,
		channelId: channel.id,
		locale: options.locale ?? 'en-US',
		guildLocale: options.guildLocale ?? guild?.preferredLocale,
		guild,
		channel,
		member: guild ? (options.member ?? mockMember({ user: author })) : null,
		options: options.options ?? {},
		metadata: options.metadata ?? {},
		logger: options.logger ?? mockLogger(),
		queues: options.queues ?? mockQueues(),
		scheduler: options.scheduler ?? mockScheduler(),
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
