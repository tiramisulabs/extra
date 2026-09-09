function extensionTypes(owner, method, checker, ts, contract, fail) {
	if (!contract) return [];
	const brand = checker.getDeclaredTypeOfSymbol(contract).getProperties()[0];
	const types = [];
	for (const decorator of ts.getDecorators(owner) ?? []) {
		const returned = checker.getTypeAtLocation(decorator.expression);
		const marker = returned
			.getProperties()
			.find(property => property.declarations?.some(declaration => brand.declarations?.includes(declaration)));
		if (!marker) continue;
		const methods = checker.getTypeOfSymbolAtLocation(marker, decorator);
		const member = methods.getProperty(method.name.text);
		if (!member) continue;
		const addition = checker.getTypeOfSymbolAtLocation(member, decorator);
		const node = checker.typeToTypeNode(
			addition,
			method,
			ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseStructuralFallback | ts.NodeBuilderFlags.InTypeAlias,
		);
		if (!node) {
			fail(decorator, 'Cannot express this context extension at the decorated method.');
			continue;
		}
		types.push(ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, owner.getSourceFile()));
	}
	return types;
}

module.exports = { extensionTypes };
