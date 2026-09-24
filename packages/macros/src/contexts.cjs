function contextType({ family, method, options, middlewares, menuInteraction, componentType, guild }) {
	const type = name => `import('seyfert').${name}`;
	const contextName = name => type(guild ? `Guild${name}` : name);
	const completed = ['run', 'onAfterRun', 'onRunError'].includes(method);
	const selected = completed ? middlewares : 'never';
	let context;
	switch (family) {
		case 'Command':
		case 'SubCommand': {
			const emptyOptions = ['onBeforeOptions', 'onOptionsError', 'onBotPermissionsFail', 'onPermissionsFail'].includes(
				method,
			);
			context = `${contextName('CommandContext')}<${emptyOptions ? '{}' : options}, ${selected}>`;
			if (method === 'onOptionsError') context += ` & { options: Partial<${type('ContextOptions')}<${options}>> }`;
			break;
		}
		case 'ComponentCommand':
			context = `${contextName('ComponentContext')}<${componentType}, ${selected}>`;
			break;
		case 'ModalCommand':
			context = `${contextName('ModalContext')}<${selected}>`;
			break;
		case 'ContextMenuCommand':
			context = `${contextName('MenuCommandContext')}<${menuInteraction}, ${selected}>`;
			break;
		case 'EntryPointCommand':
			context = `${contextName('EntryPointContext')}<${selected}>`;
			break;
	}
	if (method === 'onMiddlewaresError')
		context += ` & { metadata: Partial<${type('CommandMetadata')}<${middlewares}>> }`;
	return context;
}
module.exports = { contextType };
