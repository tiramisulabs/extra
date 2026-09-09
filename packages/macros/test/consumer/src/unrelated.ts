function Context(): MethodDecorator {
	return () => {};
}
export class Unrelated {
	@Context()
	run(ctx: { existing: string }) {
		return ctx.existing;
	}
}
