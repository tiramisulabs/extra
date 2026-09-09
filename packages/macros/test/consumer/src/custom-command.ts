import { Context } from '@slipher/macros';
import { Command, createStringOption, Options } from 'seyfert';
import $next, { increment as macroIncrement } from './default-macro.js';
import identity, { increment } from './imports.js';
import { $double as $twice } from './user-macros.js';

const options = { query: createStringOption({ description: 'Search', required: true }) };

@Options(options)
export class CustomCommand extends Command {
	@Context()
	run(ctx) {
		const query: string = ctx.options.query;
		return { query, value: $twice!(identity(19) + increment) + $next!(macroIncrement) };
	}
}
