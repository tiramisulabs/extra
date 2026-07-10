export function createFakeBullMQ() {
	const state = {
		acceptedJobs: [] as Array<{ id: string; name: string; data?: Record<string, unknown> }>,
		closeGate: undefined as Promise<void> | undefined,
		deduplications: new Map<string, { expiresAt: number; jobId: string }>(),
		failUpserts: 0,
		jobLookupGate: undefined as Promise<void> | undefined,
		jobs: new Map<string, { id: string; name: string; data?: Record<string, unknown>; repeatJobKey?: string }>(),
		jobSchedulers: [] as Array<{ id: string }>,
		nextJobId: 1,
		now: 0,
		queueEvents: [] as FakeQueueEvents[],
		queues: [] as FakeQueue[],
		workers: [] as FakeWorker[],
	};

	class FakeQueue {
		adds: Array<{ name: string; data: Record<string, unknown>; options: Record<string, unknown> }> = [];
		closed = false;
		schedulers: Array<{ id: string; repeat: Record<string, unknown>; template: Record<string, unknown> }> = [];
		removed: string[] = [];

		constructor(
			readonly name: string,
			readonly options: Record<string, unknown> = {},
		) {
			state.queues.push(this);
		}

		upsertJobScheduler(id: string, repeat: Record<string, unknown>, template: Record<string, unknown>) {
			if (state.failUpserts > 0) {
				state.failUpserts -= 1;
				throw new Error('upsert failed');
			}
			this.schedulers.push({ id, repeat, template });
		}

		add(name: string, data: Record<string, unknown>, options: Record<string, unknown>) {
			this.adds.push({ name, data, options });
			const deduplication = options.deduplication as { id?: unknown; ttl?: unknown } | undefined;
			if (typeof deduplication?.id === 'string') {
				const existing = state.deduplications.get(deduplication.id);
				if (existing && existing.expiresAt > state.now) {
					return state.jobs.get(existing.jobId);
				}
				state.deduplications.delete(deduplication.id);
			}

			const id = String(options.jobId ?? `${name}:${state.nextJobId++}`);
			const existing = state.jobs.get(id);
			if (existing) return existing;

			const job = { id, name, data };
			state.jobs.set(id, job);
			state.acceptedJobs.push(job);
			if (typeof deduplication?.id === 'string') {
				const ttl = typeof deduplication.ttl === 'number' ? deduplication.ttl : Number.POSITIVE_INFINITY;
				state.deduplications.set(deduplication.id, { expiresAt: state.now + ttl, jobId: id });
			}
			return job;
		}

		getJobSchedulers() {
			return state.jobSchedulers;
		}

		removeJobScheduler(id: string) {
			this.removed.push(id);
		}

		async close() {
			await state.closeGate;
			this.closed = true;
		}
	}

	class FakeQueueEvents {
		closed = false;
		listeners = new Map<string, ((payload: Record<string, unknown>) => void)[]>();

		constructor(
			readonly name: string,
			readonly options: Record<string, unknown> = {},
		) {
			state.queueEvents.push(this);
		}

		on(event: string, listener: (payload: Record<string, unknown>) => void) {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		}

		emit(event: string, payload: Record<string, unknown>) {
			for (const listener of this.listeners.get(event) ?? []) listener(payload);
		}

		async close() {
			await state.closeGate;
			this.closed = true;
		}
	}

	class FakeWorker {
		closed = false;

		constructor(
			readonly name: string,
			readonly processor: (job: { id?: string; name: string; data?: Record<string, unknown> }) => unknown,
			readonly options: Record<string, unknown> = {},
		) {
			state.workers.push(this);
		}

		async close() {
			await state.closeGate;
			this.closed = true;
		}
	}

	return {
		module: {
			Job: {
				fromId: async (_queue: unknown, id: string) => {
					await state.jobLookupGate;
					return state.jobs.get(id) ?? null;
				},
			},
			Queue: FakeQueue,
			QueueEvents: FakeQueueEvents,
			Worker: FakeWorker,
		},
		state,
	};
}
