import type { QueueLike } from '@slipher/types';
import type { Client, CommandContext, HttpClient, UsingClient, WorkerClient } from 'seyfert';
import {
	type Awaitable,
	type JobNameOf,
	OnQueueEvent,
	OnWorkerEvent,
	Processor,
	type Queue,
	type QueueData,
	type QueueJob,
	type QueueOf,
	type QueueRegistration,
	type QueueResult,
	type QueuesRegistry,
} from '../src';

type WelcomeJob =
	| { job: 'send'; source: 'slash-command' | 'scheduler'; userId: string }
	| { job: 'audit'; action: string };

type AuditQueue = QueueRegistration<{ action: string }, void>;
type WelcomeQueue = QueueRegistration<WelcomeJob, string>;

declare module '../src' {
	interface RegisteredQueues {
		audit: AuditQueue;
		welcome: WelcomeQueue;
	}
}

declare function expectType<T>(value: T): void;
declare const registry: QueuesRegistry;
declare const commandContext: CommandContext;
declare const concreteClient: Client;
declare const httpClient: HttpClient;
declare const workerClient: WorkerClient;
declare const client: UsingClient;

expectType<QueuesRegistry>(commandContext.queues);
expectType<QueuesRegistry | undefined>(concreteClient.queues);
expectType<QueuesRegistry | undefined>(httpClient.queues);
expectType<QueuesRegistry | undefined>(workerClient.queues);
expectType<QueuesRegistry | undefined>(client.queues);

const welcomeQueue = registry.get('welcome');
expectType<QueueOf<'welcome'>>(welcomeQueue);
expectType<Queue<{ source: 'slash-command' | 'scheduler'; userId: string } | { action: string }, string>>(welcomeQueue);
const directWelcomeJob = welcomeQueue.add('send', { source: 'slash-command', userId: 'user-1' });
expectType<Awaitable<QueueJob<{ source: 'slash-command' | 'scheduler'; userId: string }, string, 'send'>>>(
	directWelcomeJob,
);

welcomeQueue.add('audit', { action: 'deploy' });

// @ts-expect-error direct registered queue access keeps named job payloads narrow
welcomeQueue.add('send', { source: 'text-command', userId: 'user-1' });

// @ts-expect-error direct registered queue access requires known job names
welcomeQueue.add('unknown', { userId: 'user-1' });

// @ts-expect-error job-space queues require a named job
welcomeQueue.add({ source: 'slash-command', userId: 'user-1' });
expectType<ClassDecorator>(
	Processor('welcome', {
		retryDelay(job) {
			expectType<QueueData<'welcome'>>(job.data);
			return 0;
		},
	}),
);

expectType<MethodDecorator>(OnQueueEvent('completed'));
expectType<MethodDecorator>(OnWorkerEvent('active'));

const dynamicQueue = registry.get<{ value: number }, boolean>('dynamic');
expectType<Queue<{ value: number }, boolean>>(dynamicQueue);
expectType<QueueLike<{ value: number }, boolean>>(dynamicQueue);

expectType<'send' | 'audit'>({} as JobNameOf<'welcome'>);
expectType<{ source: 'slash-command' | 'scheduler'; userId: string } | { action: string }>({} as QueueData<'welcome'>);
expectType<string>({} as QueueResult<'welcome'>);
expectType<unknown>({} as QueueData<'missing'>);
