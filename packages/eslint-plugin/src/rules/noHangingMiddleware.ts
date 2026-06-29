import type { ESLintUtils, TSESLint, TSESTree } from '@typescript-eslint/utils';
import { getServices, isSeyfertSymbol } from '../utils';

// Only `next`/`stop` advance the pipeline. `pass` exists in seyfert 4.x but is
// being removed in the next major, so it does NOT count — a `pass`-only path hangs.
const ADVANCERS = new Set(['next', 'stop']);

interface FuncInfo {
	upper: FuncInfo | null;
	node: TSESTree.Node;
	codePath: TSESLint.CodePath;
	isMiddleware: boolean;
	/** Local names destructured from the context param for `next`/`stop`. */
	advancerNames: Set<string>;
	/** The context param name, for `ctx.next()` style calls. */
	paramName: string | null;
	/** Ids of segments currently being traversed in this code path. */
	currentSegments: Set<string>;
	/** Ids of segments in which an advancer was called. */
	advancedSegments: Set<string>;
}

/** Collect the `next`/`stop` bindings from a middleware callback's param. */
function readAdvancers(param: TSESTree.Parameter | undefined): {
	advancerNames: Set<string>;
	paramName: string | null;
} {
	const advancerNames = new Set<string>();
	let paramName: string | null = null;
	if (param?.type === 'Identifier') {
		paramName = param.name;
	} else if (param?.type === 'ObjectPattern') {
		for (const property of param.properties) {
			if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier') continue;
			if (!ADVANCERS.has(property.key.name)) continue;
			const value = property.value;
			if (value.type === 'Identifier') advancerNames.add(value.name);
			else if (value.type === 'AssignmentPattern' && value.left.type === 'Identifier')
				advancerNames.add(value.left.name);
		}
	}
	return { advancerNames, paramName };
}

/**
 * Flag seyfert middlewares (`createMiddleware(cb)`) that have a code path which
 * returns without calling `next()` or `stop()` — those leave the command
 * pipeline waiting forever. Uses control-flow analysis, so every branch
 * (if/else, switch, early return, loops) is checked; `throw` paths are exempt
 * (seyfert routes them to its middleware error handler, they don't hang).
 */
export default function create(createRule: ReturnType<typeof ESLintUtils.RuleCreator>) {
	return createRule({
		name: 'no-hanging-middleware',
		meta: {
			type: 'problem',
			docs: {
				description: 'Seyfert middlewares must call `next()` or `stop()` on every code path.',
			},
			messages: {
				mayHang:
					'This middleware can return without calling `next()` or `stop()`, leaving the command pipeline hanging.',
			},
			schema: [],
		},
		defaultOptions: [],
		create(context) {
			let funcInfo: FuncInfo | null = null;

			const isSeyfertMiddlewareCallback = (fn: TSESTree.Node): boolean => {
				const parent = fn.parent;
				if (!parent || parent.type !== 'CallExpression' || parent.arguments[0] !== fn) return false;
				const callee = parent.callee;
				const calleeName =
					callee.type === 'Identifier'
						? callee.name
						: callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
							? callee.property.name
							: null;
				if (calleeName !== 'createMiddleware') return false;

				const services = getServices(context);
				if (!services) return false;
				return isSeyfertSymbol(
					services.program.getTypeChecker(),
					services.getSymbolAtLocation(callee),
					'createMiddleware',
				);
			};

			const isAdvancerCall = (node: TSESTree.CallExpression, info: FuncInfo): boolean => {
				const callee = node.callee;
				if (callee.type === 'Identifier') return info.advancerNames.has(callee.name);
				return (
					callee.type === 'MemberExpression' &&
					!callee.computed &&
					callee.object.type === 'Identifier' &&
					callee.object.name === info.paramName &&
					callee.property.type === 'Identifier' &&
					ADVANCERS.has(callee.property.name)
				);
			};

			// True if a normal exit is reachable from entry without crossing a segment
			// that called an advancer.
			const canHang = (info: FuncInfo): boolean => {
				const returnedIds = new Set(info.codePath.returnedSegments.map(segment => segment.id));
				const visited = new Set<string>();
				const stack: TSESLint.CodePathSegment[] = [info.codePath.initialSegment];
				while (stack.length > 0) {
					const segment = stack.pop();
					if (!segment || visited.has(segment.id)) continue;
					visited.add(segment.id);
					if (!segment.reachable || info.advancedSegments.has(segment.id)) continue;
					if (returnedIds.has(segment.id)) return true;
					stack.push(...segment.nextSegments);
				}
				return false;
			};

			const onCodePathStart = (codePath: TSESLint.CodePath, node: TSESTree.Node): void => {
				const isMiddleware =
					(node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
					isSeyfertMiddlewareCallback(node);
				const { advancerNames, paramName } = isMiddleware
					? readAdvancers((node as TSESTree.FunctionLike).params[0])
					: { advancerNames: new Set<string>(), paramName: null };
				funcInfo = {
					upper: funcInfo,
					node,
					codePath,
					isMiddleware,
					advancerNames,
					paramName,
					currentSegments: new Set(),
					advancedSegments: new Set(),
				};
			};

			const onCodePathEnd = (_codePath: TSESLint.CodePath, _node: TSESTree.Node): void => {
				const info = funcInfo;
				funcInfo = info?.upper ?? null;
				if (info?.isMiddleware && canHang(info)) {
					context.report({ node: info.node, messageId: 'mayHang' });
				}
			};

			const onCodePathSegmentStart = (segment: TSESLint.CodePathSegment): void => {
				funcInfo?.currentSegments.add(segment.id);
			};

			const onCodePathSegmentEnd = (segment: TSESLint.CodePathSegment): void => {
				funcInfo?.currentSegments.delete(segment.id);
			};

			return {
				onCodePathStart: onCodePathStart as unknown as TSESLint.RuleFunction,
				onCodePathEnd: onCodePathEnd as unknown as TSESLint.RuleFunction,
				onCodePathSegmentStart: onCodePathSegmentStart as unknown as TSESLint.RuleFunction,
				onCodePathSegmentEnd: onCodePathSegmentEnd as unknown as TSESLint.RuleFunction,
				CallExpression(node) {
					if (funcInfo?.isMiddleware && isAdvancerCall(node, funcInfo)) {
						for (const id of funcInfo.currentSegments) funcInfo.advancedSegments.add(id);
					}
				},
			};
		},
	});
}
