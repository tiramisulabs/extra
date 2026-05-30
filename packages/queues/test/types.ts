import type { Client, CommandContext, UsingClient, WorkerClient } from 'seyfert';
import {
	InjectQueue,
	Processor,
	type Queue,
	type QueueData,
	type QueueJob,
	type QueueJobOf,
	type QueueOf,
	type QueueRegistration,
	type QueueResult,
	type QueuesRegistry,
} from '../src';

interface WelcomeJob {
	source: 'slash-command' | 'scheduler';
	userId: string;
}

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
declare const workerClient: WorkerClient;
declare const client: UsingClient;

expectType<QueuesRegistry>(commandContext.queues);
expectType<QueuesRegistry>(concreteClient.queues);
expectType<QueuesRegistry>(workerClient.queues);
expectType<QueuesRegistry>(client.queues);

const welcomeQueue = registry.get('welcome');
expectType<QueueOf<'welcome'>>(welcomeQueue);
expectType<Queue<WelcomeJob, string>>(welcomeQueue);
expectType<ClassDecorator>(
	Processor('welcome', {
		retryDelay(job) {
			expectType<WelcomeJob>(job.data);
			return 0;
		},
	}),
);
expectType<ParameterDecorator>(InjectQueue('welcome'));

const welcomeJob = registry.add('welcome', { source: 'slash-command', userId: 'user-1' });
expectType<Promise<QueueJobOf<'welcome'>>>(welcomeJob);
expectType<Promise<QueueJob<WelcomeJob, string>>>(welcomeJob);

registry.add('audit', { action: 'deploy' });

// @ts-expect-error registered queues require their declared payload shape
registry.add('welcome', { source: 'slash-command' });

// @ts-expect-error registered queue names cannot fall through to the dynamic overload
registry.add('welcome', { source: 'text-command', userId: 'user-1' });

const dynamicJob = registry.add('dynamic', { ok: true });
expectType<Promise<QueueJob<{ ok: boolean }, unknown>>>(dynamicJob);

const dynamicQueue = registry.get<{ value: number }, boolean>('dynamic');
expectType<Queue<{ value: number }, boolean>>(dynamicQueue);

expectType<WelcomeJob>({} as QueueData<'welcome'>);
expectType<string>({} as QueueResult<'welcome'>);
expectType<unknown>({} as QueueData<'missing'>);
