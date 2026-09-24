import { $$raw } from '@slipher/macros/builtin';

export function $double(value: number): number {
	return $$raw!((context, input) => {
		return context.factory.createMultiply(input, context.factory.createNumericLiteral(2));
	});
}

function $record(events: string[], value: string): void {
	events.push(value);
}

export function execute() {
	const events: string[] = [];
	$record!(events, 'expanded');
	return { events, value: $double!(21) };
}
