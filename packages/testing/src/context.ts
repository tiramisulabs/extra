import { createMockChannel, createMockGuild, createMockMember, createMockUser } from './factories';
import { createRecorder, type Recorder } from './recorder';

export type MockContextResponse = Record<string, unknown> | string;
export type MockContextRecorder = Recorder<[MockContextResponse], unknown>;

export interface MockCommandContextOptions {
	commandName?: string;
	fullCommandName?: string;
	userId?: string;
	guildId?: string;
	channelId?: string;
	locale?: string;
	guildLocale?: string;
	author?: ReturnType<typeof createMockUser>;
	guild?: ReturnType<typeof createMockGuild> | null;
	channel?: ReturnType<typeof createMockChannel>;
	member?: ReturnType<typeof createMockMember>;
}

export interface MockCommandContext {
	command: { name: string };
	fullCommandName: string;
	author: ReturnType<typeof createMockUser>;
	user: ReturnType<typeof createMockUser>;
	guildId?: string;
	channelId: string;
	locale: string;
	guildLocale?: string;
	guild: ReturnType<typeof createMockGuild> | null;
	channel: ReturnType<typeof createMockChannel>;
	member: ReturnType<typeof createMockMember> | null;
	responses: MockContextResponse[];
	write: MockContextRecorder;
	editOrReply: MockContextRecorder;
	followup: MockContextRecorder;
	deferReply: Recorder<[], unknown>;
	clearResponses(): void;
	lastResponse(): MockContextResponse | undefined;
}

export function createMockCommandContext(options: MockCommandContextOptions = {}): MockCommandContext {
	const author = options.author ?? createMockUser({ id: options.userId });
	const guild = options.guild === null ? null : (options.guild ?? createMockGuild({ id: options.guildId }));
	const guildId = guild?.id ?? options.guildId;
	const channel = options.channel ?? createMockChannel({ id: options.channelId, guildId: guildId ?? null });
	const responses: MockContextResponse[] = [];
	const createResponseRecorder = () =>
		createRecorder<[MockContextResponse], unknown>(response => {
			responses.push(response);
			return response;
		});
	const write = createResponseRecorder();
	const editOrReply = createResponseRecorder();
	const followup = createResponseRecorder();

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
		member: options.member ?? (guild ? createMockMember({ user: author }) : null),
		responses,
		write,
		editOrReply,
		followup,
		deferReply: createRecorder<[], unknown>(),
		clearResponses() {
			responses.length = 0;
			write.clear();
			editOrReply.clear();
			followup.clear();
		},
		lastResponse() {
			return responses.at(-1);
		},
	};
}
