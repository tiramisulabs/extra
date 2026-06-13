import { Client, type Command, type ContextMenuCommand, type UsingClient } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle';
import type { ClientEvent } from 'seyfert/lib/events/event';
import type { APIInteraction, APIInteractionResponse, GatewayDispatchPayload } from 'seyfert/lib/types';
import {
	type ApiInteractionPayload,
	type ChatInputInteractionOptions,
	type ModalSubmitInteractionOptions,
	chatInputInteraction,
	modalSubmitInteraction,
} from './interactions';
import { type ApiUser, apiUser } from './payloads';
import { type MatchedAction, MockApiHandler, type RecordedAction, type RouteMatcher } from './rest';
import { FOLLOWUP_ROUTE, ORIGINAL_RESPONSE_ROUTE } from './routes';
import { type MockWorld, type WorldBuilder, seedWorld } from './world';

type ClientConstructorOptions = ConstructorParameters<typeof Client>[0];
type ServicesOptions = Parameters<Client['setServices']>[0];

export interface CapturedReply {
	body: APIInteractionResponse;
	files?: unknown;
}

export interface OutgoingMessage {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
	[key: string]: unknown;
}

export interface DispatchResult {
	replies: CapturedReply[];
	reply?: CapturedReply;
	deferred: boolean;
	ephemeral: boolean;
	modal?: { customId?: string; title?: string };
	edits: OutgoingMessage[];
	followups: OutgoingMessage[];
	actions: RecordedAction[];
	content?: string;
}

export class Dispatch<T = DispatchResult> implements PromiseLike<T> {
	private execution?: Promise<T>;
	private releasePending?: () => void;
	private settled = false;

	constructor(
		private readonly rest: MockApiHandler,
		private readonly clientRef: Client,
		readonly userId: string | undefined,
		private readonly executor: () => Promise<T>,
	) {}

	private start(): Promise<T> {
		this.execution ??= this.executor();
		return this.execution;
	}

	private releaseCheckpoint(): void {
		const release = this.releasePending;
		this.releasePending = undefined;
		release?.();
	}

	async until(matcher: RouteMatcher | ((action: RecordedAction) => boolean)): Promise<RecordedAction> {
		if (this.settled) {
			throw new TypeError(
				'Dispatch.until(): this dispatch already ran to completion - step with until() before awaiting it.',
			);
		}
		const gated = this.rest.gateNext(matcher);
		const previous = this.releasePending;
		this.releasePending = gated.release;
		this.start();
		previous?.();
		return gated.hit;
	}

	async untilModal(timeoutMs = 2000): Promise<void> {
		if (!this.userId) {
			throw new TypeError('untilModal: this dispatch has no user - pass `user` to the dispatch options');
		}
		this.releaseCheckpoint();
		this.start();
		const deadline = Date.now() + timeoutMs;
		while (!this.clientRef.components.modals.has(this.userId)) {
			if (Date.now() > deadline) {
				const waiting = [...this.clientRef.components.modals.keys()].join(', ') || '(none)';
				throw new Error(
					`untilModal: no modal was opened for user ${this.userId} within ${timeoutMs}ms. ` +
						`Modals are waiting for: ${waiting}.`,
				);
			}
			await new Promise(resolve => setImmediate(resolve));
		}
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.releaseCheckpoint();
		this.settled = true;
		return this.start().then(onfulfilled, onrejected);
	}
}

export type MockCommandClass = new () => Command | ContextMenuCommand;
export type MockEvent = Omit<ClientEvent, 'data'> & {
	data: Omit<ClientEvent['data'], 'once'> & { once?: boolean };
};

export interface MockBotOptions {
	commands?: MockCommandClass[];
	components?: Parameters<Client['components']['set']>[0];
	events?: MockEvent[];
	middlewares?: ServicesOptions['middlewares'];
	world?: MockWorld | WorldBuilder;
	onUnhandledRest?: 'warn' | 'error' | 'silent';
	simulateGateway?: boolean;
	botId?: string;
	applicationId?: string;
	clientOptions?: ClientConstructorOptions;
}

export class MockBot {
	readonly defaultUser: ApiUser = apiUser({ id: 'slipher-default-user', username: 'slipher-tester' });

	constructor(
		readonly client: Client,
		readonly rest: MockApiHandler,
		protected readonly world?: MockWorld,
	) {}

	get actions(): readonly RecordedAction[] {
		return this.rest.actions;
	}

	waitForAction(
		matcherOrPredicate: RouteMatcher | ((action: RecordedAction) => boolean),
		timeoutMs?: number,
	): Promise<RecordedAction> {
		if (typeof matcherOrPredicate === 'function') return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
		return this.rest.waitForAction(matcherOrPredicate, timeoutMs);
	}

	calls(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction[] {
		return this.rest.calls(matcher, params);
	}

	call(
		matcher: RouteMatcher | ((action: RecordedAction) => boolean),
		params?: Record<string, string>,
	): MatchedAction | undefined {
		return this.rest.call(matcher, params);
	}

	clearActions(): void {
		this.rest.clearActions();
	}

	dispatchInteraction(payload: ApiInteractionPayload): Dispatch<DispatchResult> {
		const userId = payload.member?.user.id ?? payload.user?.id;
		return new Dispatch(this.rest, this.client, userId, () => this.runInteraction(payload));
	}

	private async runInteraction(payload: ApiInteractionPayload): Promise<DispatchResult> {
		const startSeq = this.rest.actions.length;
		const replies: CapturedReply[] = [];
		await this.client.handleCommand.interaction(payload as unknown as APIInteraction, -1, async reply => {
			replies.push(reply);
		});
		const actions = this.rest.actions.slice(startSeq);
		if (replies.length === 0) {
			const callback = actions.find(
				action =>
					action.method === 'POST' && action.route === `/interactions/${payload.id}/${payload.token}/callback`,
			);
			if (callback?.body) replies.push({ body: callback.body as unknown as APIInteractionResponse, files: callback.files });
		}
		const edits = actions
			.filter(
				action =>
					action.method === 'PATCH' &&
					ORIGINAL_RESPONSE_ROUTE.test(action.route) &&
					action.route.includes(payload.token),
			)
			.map(action => (action.body ?? {}) as OutgoingMessage);
		const followups = actions
			.filter(
				action =>
					action.method === 'POST' && FOLLOWUP_ROUTE.test(action.route) && action.route.includes(payload.token),
			)
			.map(action => (action.body ?? {}) as OutgoingMessage);

		return {
			replies,
			edits,
			followups,
			actions,
			get reply() {
				return replies[0];
			},
			get deferred() {
				return replies[0]?.body.type === 5 || replies[0]?.body.type === 6;
			},
			get ephemeral() {
				const body = replies[0]?.body;
				const data = body && 'data' in body ? (body.data as { flags?: number } | undefined) : undefined;
				return Boolean(data?.flags && data.flags & 64);
			},
			get modal() {
				const body = replies[0]?.body;
				if (body?.type !== 9) return undefined;
				const data = body.data as { custom_id?: string; title?: string } | undefined;
				return { customId: data?.custom_id, title: data?.title };
			},
			get content() {
				const reply = replies[0];
				const replyContent =
					reply && 'data' in reply.body ? (reply.body.data as { content?: string } | undefined)?.content : undefined;
				return edits.at(-1)?.content ?? replyContent;
			},
		};
	}

	private assertCommandRegistered(name: string): void {
		const registered = this.client.commands.values.map(command => command.name);
		if (!registered.includes(name)) {
			throw new TypeError(
				`slash: command "${name}" is not registered. Registered commands: ${registered.join(', ') || '(none)'}`,
			);
		}
	}

	slash(options: ChatInputInteractionOptions): Dispatch<DispatchResult> {
		this.assertCommandRegistered(options.name);
		return this.dispatchInteraction(chatInputInteraction({ user: this.defaultUser, ...options }));
	}

	fillModal(
		customId: string,
		fields: Record<string, string> = {},
		extra: Omit<ModalSubmitInteractionOptions, 'customId' | 'fields'> = {},
	): Dispatch<DispatchResult> {
		return this.dispatchInteraction(modalSubmitInteraction({ user: this.defaultUser, ...extra, customId, fields }));
	}

	async emitEvent<TName extends GatewayDispatchPayload['t']>(
		name: TName,
		payload: Partial<Extract<GatewayDispatchPayload, { t: TName }>['d']> & Record<string, unknown>,
		options?: { updateCache?: boolean },
	): Promise<void>;
	async emitEvent(name: string, payload: Record<string, unknown>, options?: { updateCache?: boolean }): Promise<void>;
	async emitEvent(name: string, payload: Record<string, unknown>, { updateCache = true } = {}): Promise<void> {
		await this.client.events.runEvent(
			name as Parameters<Client['events']['runEvent']>[0],
			this.client,
			payload,
			-1,
			updateCache,
		);
	}

	async close(): Promise<void> {
		await this.client.close();
	}
}

export async function createMockBot(options: MockBotOptions = {}): Promise<MockBot> {
	const rest = new MockApiHandler({ onUnhandledRest: options.onUnhandledRest });
	const built =
		options.world && typeof (options.world as WorldBuilder).build === 'function'
			? (options.world as WorldBuilder).build()
			: (options.world as MockWorld | undefined);
	const world = built ? structuredClone(built) : undefined;
	const client = new Client(options.clientOptions);

	client.setServices({
		rest,
		handleCommand: HandleCommand,
		...(options.middlewares ? { middlewares: options.middlewares } : {}),
	});
	client.botId = options.botId ?? 'slipher-test-bot';
	client.applicationId = options.applicationId ?? 'slipher-test-application';

	if (options.commands) {
		client.commands.set(options.commands as unknown as Parameters<Client['commands']['set']>[0]);
	}
	if (options.components) client.components.set(options.components);
	if (options.events) {
		const events = options.events.map(event => ({ ...event, data: { once: false, ...event.data } }));
		client.events.set(events as Parameters<Client['events']['set']>[0]);
	}

	await (client as unknown as { setupPlugins(): Promise<void> }).setupPlugins();
	if (world) await seedWorld(client as unknown as UsingClient, world);

	return new MockBot(client, rest, world);
}
