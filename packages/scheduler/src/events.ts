import type { SchedulerEventName, SchedulerEventPayloads, SchedulerListener, SchedulerLogger } from './types';

export class SchedulerEmitter {
	private listeners = new Map<string, Set<SchedulerListener<any>>>();

	constructor(private logger?: SchedulerLogger) {}

	setLogger(logger?: SchedulerLogger) {
		this.logger = logger;
	}

	on<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		const listeners = this.listeners.get(event) ?? new Set<SchedulerListener<any>>();
		listeners.add(listener as SchedulerListener<any>);
		this.listeners.set(event, listeners);

		return () => this.off(event, listener);
	}

	once<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		const off = this.on(event, payload => {
			off();
			return listener(payload);
		});

		return off;
	}

	off<TEvent extends SchedulerEventName>(event: TEvent, listener: SchedulerListener<SchedulerEventPayloads[TEvent]>) {
		this.listeners.get(event)?.delete(listener as SchedulerListener<any>);
	}

	emit<TEvent extends SchedulerEventName>(event: TEvent, payload: SchedulerEventPayloads[TEvent]) {
		for (const listener of this.listeners.get(event) ?? []) {
			try {
				const result = listener(payload);
				Promise.resolve(result).catch(error => this.reportListenerError(event, error));
			} catch (error) {
				this.reportListenerError(event, error);
			}
		}
	}

	private reportListenerError(event: string, error: unknown) {
		if (this.logger?.error) {
			this.logger.error({ event, error }, 'Scheduler listener failed');
			return;
		}

		if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
			process.emitWarning(error instanceof Error ? error : String(error), {
				type: 'SchedulerListenerError',
			});
		}
	}
}
