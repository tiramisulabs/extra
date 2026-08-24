import { context, createContextKey, type SpanContext } from '@opentelemetry/api';

export interface InteractionFlowCarrier {
	flowId: string;
	spanContext?: SpanContext;
	interactionStartedAt?: number;
}

const FLOW_CARRIER = createContextKey('@slipher/opentelemetry interaction flow');

export function currentInteractionFlow(): InteractionFlowCarrier | undefined {
	return context.active().getValue(FLOW_CARRIER) as InteractionFlowCarrier | undefined;
}

export function withInteractionFlow<T>(carrier: InteractionFlowCarrier, run: () => T): T {
	return context.with(context.active().setValue(FLOW_CARRIER, carrier), run);
}
