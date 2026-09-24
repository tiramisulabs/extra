/** Infers this method's Seyfert context. Removed by the compiler. */
export declare function Context(): MethodDecorator;

/** Select the existing Guild context type; does not enforce guild-only execution. */
export declare function GuildContext(): MethodDecorator;

declare const contextExtension: unique symbol;

/** Type-only contract for a class decorator. Each key names a hook whose context it extends. */
export interface ContextExtension<Methods extends { [Key in keyof Methods]: object }> {
	readonly [contextExtension]: Methods;
}
