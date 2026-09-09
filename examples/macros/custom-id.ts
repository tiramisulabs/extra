/** Parameters occupy a complete, nonempty segment. The separator defaults to ':'. */
export function CustomId<const Pattern extends string, const Separator extends string = ':'>(
	pattern: Pattern,
	separator?: Separator,
) {
	const delimiter = separator ?? ':';
	if (!delimiter) throw new Error('CustomId separator must not be empty');
	const names = new Set<string>();
	const segments = pattern.split(delimiter).map(segment => {
		const parameter = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segment);
		if (!parameter) {
			if (/[{}]/.test(segment)) throw new Error(`Invalid CustomId segment: ${segment}`);
			return { literal: segment };
		}
		const name = parameter[1];
		if (names.has(name)) throw new Error(`Duplicate CustomId parameter: ${name}`);
		names.add(name);
		return { name };
	});
	const decorate = (target: { prototype: ComponentCommand }) => {
		const original = target.prototype.filter;
		target.prototype.filter = function (context: ComponentContext) {
			const values = context.customId.split(delimiter);
			if (values.length !== segments.length) return false;
			const params: Record<string, string> = Object.create(null);
			for (const [index, segment] of segments.entries()) {
				if (segment.name !== undefined) {
					if (!values[index]) return false;
					params[segment.name] = values[index];
				} else if (segment.literal !== values[index]) return false;
			}
			Object.assign(context, { params });
			return original ? original.call(this, context) : true;
		};
	};
	return decorate as typeof decorate &
		ContextExtension<{
			filter: { params: Params<Pattern, Separator> };
			run: { params: Params<Pattern, Separator> };
		}>;
}

type Params<Pattern extends string, Separator extends string> = string extends Pattern | Separator
	? Record<string, string | undefined>
	: Pattern extends unknown
		? Separator extends unknown
			? {
					[Key in ParameterNames<Pattern, Separator>]: string;
				}
			: never
		: never;
type ParameterNames<Pattern extends string, Separator extends string> = Separator extends ''
	? never
	: Pattern extends `${infer First}${Separator}${infer Rest}`
		? ParameterNames<First, Separator> | ParameterNames<Rest, Separator>
		: Pattern extends `{${infer Name}}`
			? Name
			: never;

import type { ContextExtension } from '@slipher/macros';
import type { ComponentCommand, ComponentContext } from 'seyfert';
