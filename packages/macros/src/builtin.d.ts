import type * as ts from 'typescript';

/** Minimal AST surface of the bundled ts-macros engine. */
export interface RawContext {
	ts: typeof ts;
	factory: ts.NodeFactory;
	checker: ts.TypeChecker;
	thisMacro: { target?: ts.Node };
}

/** Runs while compiling; the returned AST becomes the emitted code. */
export declare function $$raw<T>(
	fn: (context: RawContext, ...arguments_: ts.Expression[]) => ts.Node | ts.Node[] | undefined,
): T;
export type EmptyDecorator = (...arguments_: unknown[]) => void;
